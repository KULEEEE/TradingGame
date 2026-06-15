import crypto from 'node:crypto';
import { EV, STRENGTH_DRIFT, TREND_PRESETS, VOL_PRESETS } from '../shared/events.js';

const DEFAULT_TICK_SEC = Math.max(1, Number(process.env.TICK_SEC) || 10); // 가격 틱 기본 간격 (초)
const MIN_TICK_SEC = 1;
const MAX_TICK_SEC = 60;
const MAX_CANDLES = 360;
const MAX_TRADES = 100;     // 참가자별 거래내역 보관 수
const MAX_NEWS = 30;
const NEWS_TTL_MS = 120_000; // 티커/재접속 시 이 시간 지난 뉴스는 내려주지 않음
const SPARK_LEN = 90;       // 스파크라인 포인트 수
const DELIST_COUNTDOWN_SEC = 30; // 상폐 카운트다운 (초)
const MAX_DAYS = 30;        // 총 거래일 상한

// ── 가격 엔진(추세선 + 평균회귀 + 행동모델) 파라미터 ──
const KAPPA = 0.08;          // 평균회귀 속도(초당). 클수록 추세선을 단단히 따라가 출렁임이 작아짐
const MAX_SIGMA_STEP = 0.5;  // 한 틱 변동성 상한(폭주 방지)
// 행동 이벤트 — 한쪽으로만 흐르지 않게 추세 중간에 끼어드는 모멘텀/되돌림(상·하 대칭)
const TREND_WINDOW_SEC = 60;     // 단기 추세 판단 구간(초)
const PROFIT_DEV = 0.08;         // 추세선 대비 ±8% 이상 괴리 → 회귀 가속(차익실현/저가매수) 후보
const PROFIT_RUN = 0.08;         // 단기 ±8% 이상 변동 → 회귀 가속 후보
const PROFIT_PROB = 0.25;        // 틱당 회귀 가속 발생 확률
const MOMENTUM_DRIFT = 0.006;    // 패닉셀/추격매수 모멘텀 드리프트(초당, ±)
const REVERT_DRIFT = 0.004;      // 차익실현/저가매수 되돌림 드리프트(초당, ±)
const PANIC_DROP = 0.07;         // 단기 ±7% 이상 급변 → 모멘텀(패닉셀/추격매수) 후보
const PANIC_PROB = 0.35;         // 틱당 모멘텀 발생 확률
const BEHAVIOR_COOLDOWN_SEC = 30; // 행동 이벤트 재발동 쿨다운(초)

// 틱 간격(초)을 허용 범위로 보정. 잘못된 값이면 null 반환.
const clampTickSec = (sec) => {
  const v = Math.round(Number(sec));
  if (!Number.isFinite(v)) return null;
  return Math.min(MAX_TICK_SEC, Math.max(MIN_TICK_SEC, v));
};

const clampDays = (n) => Math.min(MAX_DAYS, Math.max(1, Math.round(Number(n) || 1)));

export const DEFAULT_SETTINGS = { initialCash: 10_000_000, durationMin: 5, feeRate: 0, totalDays: 3 };

const now = () => Date.now();
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

/** 표준정규 난수 (Box-Muller) */
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Game {
  constructor(io, stockDefs, settings = {}) {
    this.io = io;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.tickSec = clampTickSec(settings.tickSec) ?? DEFAULT_TICK_SEC; // 가격 틱 간격 (초)
    this.status = 'lobby'; // lobby | running | paused | intermission | ended
    this.currentDay = 0;   // 0=아직 미개장, 1..totalDays
    this.endsAt = null;
    this.remainingMs = this.settings.durationMin * 60_000;
    this.stocks = new Map();   // symbol -> stock
    this.players = new Map();  // token -> player
    this.news = [];
    this.tickCount = 0;
    for (const def of stockDefs) this.addStock(def, { silent: true });
    this.startTickTimer();
    // 틱이 길어도 거래일 마감은 1초 단위로 체크
    this.endTimer = setInterval(() => {
      if (this.status === 'running' && now() >= this.endsAt) this.closeDay();
    }, 1000);
  }

  // 틱 간격에서 파생되는 값들
  get tickMs() { return this.tickSec * 1000; }
  get candleSec() { return Math.max(10, this.tickSec * 6); } // 캔들 1개 = 6틱 (기본 1분봉)

  // 시뮬레이션 파라미터(drift/volatility/STRENGTH_DRIFT)는 모두 "초당" 값.
  // 한 틱이 tickSec초이므로 GBM 1스텝은 μ·dt, σ·√dt 로 스케일한다.
  secToTicks(sec) { return Math.max(1, Math.round(sec / this.tickSec)); }

  /** 현재 tickSec으로 틱 타이머를 (재)시작 */
  startTickTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** 틱 간격(초) 변경. 타이머를 즉시 재시작하고 변경 사항을 브로드캐스트한다. */
  setTickSec(sec) {
    const v = clampTickSec(sec);
    if (v == null) return { ok: false, error: '틱 간격이 올바르지 않습니다' };
    if (v === this.tickSec) return { ok: true };
    this.tickSec = v;
    this.startTickTimer();
    this.addNews(`⏱ 가격 변동 주기가 ${v}초로 변경되었습니다`, 'info');
    this.broadcastStocks(); // delistIn(초)은 tickSec에 의존
    this.broadcastGame();
    return { ok: true };
  }

  // ───────────────────────── 종목 ─────────────────────────

  addStock(def, opts = {}) {
    const symbol = String(def.symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{1,6}$/.test(symbol)) return { ok: false, error: '심볼은 영문/숫자 1~6자' };
    if (this.stocks.has(symbol)) return { ok: false, error: '이미 있는 심볼입니다' };
    const initialPrice = Math.max(1, Math.round(Number(def.initialPrice) || 0));
    if (!initialPrice || !def.name) return { ok: false, error: '이름/시작가를 확인하세요' };
    const s = {
      symbol,
      name: String(def.name).slice(0, 20),
      initialPrice,
      basePrice: initialPrice, // 전일 종가(등락률 기준). 거래일 개장 시 갱신
      price: initialPrice,     // 내부적으로 float 유지, 송출 시 반올림
      fairValue: initialPrice, // 추세선(적정가). 시나리오 기울기대로 이동, 가격이 회귀
      plannedDrift: 0,         // 이번 거래일 추세선 초당 드리프트(시나리오 환산)
      dayVolMul: 1,            // 이번 거래일 변동성 배수(시나리오)
      scenario: { trend: 'flat', vol: 'mid' }, // 다음 거래일에 예약된 추세 프리셋
      dayScenario: null,       // 이번(현재) 거래일에 실제 적용 중인 추세 프리셋
      behaviorCooldown: 0,     // 행동 이벤트 쿨다운(남은 틱)
      volatility: Number(def.volatility) || 0.02,
      drift: Number(def.drift) || 0,
      modifiers: [],           // { driftDelta, volMul, ticksLeft }
      halted: false,
      delisted: false,
      delistTicks: null,       // 상폐 카운트다운 (남은 틱)
      candles: [],             // 확정된 10초봉
      candle: null,            // 만들고 있는 봉
      spark: [initialPrice],
    };
    this.stocks.set(symbol, s);
    if (!opts.silent) this.broadcastStocks();
    return { ok: true };
  }

  updateStock(symbol, { volatility, drift }) {
    const s = this.stocks.get(symbol);
    if (!s) return { ok: false, error: '없는 종목' };
    if (volatility != null && Number.isFinite(Number(volatility)))
      s.volatility = Math.min(0.5, Math.max(0, Number(volatility)));
    if (drift != null && Number.isFinite(Number(drift)))
      s.drift = Math.min(0.1, Math.max(-0.1, Number(drift)));
    this.broadcastStocks();
    return { ok: true };
  }

  removeStock(symbol) {
    const s = this.stocks.get(String(symbol || '').toUpperCase());
    if (!s) return { ok: false, error: '없는 종목' };
    // 보유자가 있으면 현재가로 강제 매도(수수료 없음). 상폐 종목은 0원이므로 그냥 소멸.
    const price = s.delisted ? 0 : Math.round(s.price);
    let sold = false;
    for (const p of this.players.values()) {
      const h = p.holdings[s.symbol];
      if (!h) continue;
      if (price > 0) {
        p.cash += price * h.qty;
        p.trades.unshift({ id: rid(6), ts: now(), symbol: s.symbol, name: s.name, side: 'sell', qty: h.qty, price, fee: 0 });
        if (p.trades.length > MAX_TRADES) p.trades.pop();
        sold = true;
      }
      delete p.holdings[s.symbol];
      this.emitMe(p);
    }
    this.stocks.delete(s.symbol);
    this.addNews(`🗑 ${s.name}(${s.symbol}) 종목 삭제${sold ? ' — 보유분은 현재가로 자동 매도되었습니다' : ''}`, 'info');
    this.broadcastStocks();
    this.scheduleLeaderboard();
    return { ok: true };
  }

  haltStock(symbol, halted) {
    const s = this.stocks.get(symbol);
    if (!s || s.delisted) return { ok: false, error: '없는 종목이거나 상장폐지됨' };
    s.halted = !!halted;
    this.addNews(`${halted ? '⛔' : '🟢'} ${s.name}(${s.symbol}) 거래${halted ? '정지' : ' 재개'}`, halted ? 'alert' : 'info');
    this.broadcastStocks();
    return { ok: true };
  }

  jumpStock(symbol, pct) {
    const s = this.stocks.get(symbol);
    if (!s || s.delisted) return { ok: false, error: '없는 종목이거나 상장폐지됨' };
    const p = Math.max(-90, Math.min(300, Number(pct) || 0));
    s.price = Math.max(1, s.price * (1 + p / 100));
    // 틱 간격이 길어도 점프는 즉시 보이도록 바로 브로드캐스트
    const ts = now();
    const rounded = Math.round(s.price);
    this.recordPrice(s, rounded, Math.floor(ts / 1000 / this.candleSec) * this.candleSec);
    this.io.emit(EV.TICK, { ts, prices: { [s.symbol]: rounded } });
    return { ok: true };
  }

  surgeStock(symbol, direction, strength, durationSec) {
    const s = this.stocks.get(symbol);
    if (!s || s.delisted) return { ok: false, error: '없는 종목이거나 상장폐지됨' };
    const d = STRENGTH_DRIFT[strength] ?? STRENGTH_DRIFT.mid;
    const dir = direction >= 0 ? 1 : -1;
    const ticks = this.secToTicks(Math.max(5, Math.min(300, Number(durationSec) || 30)));
    s.modifiers.push({ driftDelta: dir * d, volMul: 1.3, ticksLeft: ticks });
    return { ok: true };
  }

  marketEvent(direction, strength, durationSec) {
    const d = STRENGTH_DRIFT[strength] ?? STRENGTH_DRIFT.mid;
    const dir = direction >= 0 ? 1 : -1;
    const ticks = this.secToTicks(Math.max(5, Math.min(300, Number(durationSec) || 30)));
    for (const s of this.stocks.values()) {
      if (s.delisted) continue;
      s.modifiers.push({ driftDelta: dir * d, volMul: 1.5, ticksLeft: ticks });
    }
    this.addNews(dir > 0 ? '🚀 시장 전체 호황! 전 종목 상승 압력' : '📉 시장 전체 폭락! 전 종목 하락 압력', 'alert');
    return { ok: true };
  }

  delistStock(symbol, immediate = false) {
    const s = this.stocks.get(symbol);
    if (!s || s.delisted) return { ok: false, error: '없는 종목이거나 이미 상장폐지됨' };
    if (immediate) {
      this.executeDelist(s);
      this.broadcastStocks();
      return { ok: true };
    }
    if (s.delistTicks != null) return { ok: false, error: '이미 상폐 진행 중' };
    const ticks = this.secToTicks(DELIST_COUNTDOWN_SEC);
    s.delistTicks = ticks;
    s.halted = false; // 탈출 기회를 줘야 하므로 거래는 열어둠
    s.modifiers.push({ driftDelta: -0.06, volMul: 2, ticksLeft: ticks });
    this.addNews(`🚨 [상장폐지 경고] ${s.name}(${s.symbol}) ${ticks * this.tickSec}초 후 상장폐지! 지금이 마지막 탈출 기회`, 'alert');
    this.broadcastStocks();
    return { ok: true };
  }

  executeDelist(s) {
    s.delisted = true;
    s.halted = false;
    s.delistTicks = null;
    s.modifiers = [];
    s.price = 0;
    if (s.candle) { s.candles.push(s.candle); s.candle = null; }
    s.spark.push(0);
    this.addNews(`💀 ${s.name}(${s.symbol}) 상장폐지. 보유 주식은 휴지조각이 되었습니다`, 'alert');
  }

  // ───────────────────────── 거래일 / 시나리오 ─────────────────────────

  /** 다음 거래일 추세/변동성 프리셋 세팅 (대기·휴장 중) */
  setScenario(symbol, trend, vol) {
    const s = this.stocks.get(String(symbol || '').toUpperCase());
    if (!s) return { ok: false, error: '없는 종목' };
    if (trend != null) {
      if (!TREND_PRESETS[trend]) return { ok: false, error: '잘못된 추세 프리셋' };
      s.scenario.trend = trend;
    }
    if (vol != null) {
      if (!VOL_PRESETS[vol]) return { ok: false, error: '잘못된 변동성 프리셋' };
      s.scenario.vol = vol;
    }
    this.broadcastStocks();
    return { ok: true };
  }

  /** 시나리오 프리셋 → 이번 거래일의 추세선 드리프트/변동성 배수로 환산 */
  applyScenario(s) {
    const trend = TREND_PRESETS[s.scenario.trend] || TREND_PRESETS.flat;
    const volp = VOL_PRESETS[s.scenario.vol] || VOL_PRESETS.mid;
    const daySec = Math.max(1, this.settings.durationMin * 60);
    // 하루 목표 변화율(daily)을 장 길이로 나눠 초당 드리프트로 환산 → 장 시간 무관하게 추세폭 일정
    s.plannedDrift = Math.log(1 + trend.daily) / daySec;
    s.dayVolMul = volp.mul;
  }

  /** 거래일 개장: 추세선/등락률 기준 초기화 후 running 진입 */
  openDay(day) {
    this.currentDay = day;
    for (const s of this.stocks.values()) {
      if (s.delisted) continue;
      this.applyScenario(s);
      s.dayScenario = { ...s.scenario };  // 이번 거래일에 적용된 추세(현재 적용 중)
      s.basePrice = Math.round(s.price);  // 전일 종가 = 이번 거래일 등락률 기준
      s.fairValue = s.price;              // 추세선은 시가에서 출발
      s.modifiers = [];
      s.behaviorCooldown = 0;
    }
    this.status = 'running';
    this.endsAt = now() + this.settings.durationMin * 60_000;
    this.remainingMs = this.settings.durationMin * 60_000;
  }

  /** 거래일 마감: 종가 동결 후 휴장(또는 마지막 날이면 게임 종료) */
  closeDay() {
    if (this.status !== 'running') return;
    const last = this.currentDay >= this.settings.totalDays;
    if (last) { this.endGame(); return; }
    this.status = 'intermission';
    this.remainingMs = 0;
    // 진행 중 modifier/상폐 카운트다운은 휴장 동안 동결만; 다음날 개장 시 정리
    this.addNews(`🔔 ${this.currentDay}거래일 장 마감 (총 ${this.settings.totalDays}일). 휴장 — 다음날 추세를 설정하세요`, 'alert');
    this.broadcastStocks();
    this.broadcastGame();
    this.broadcastLeaderboard();
  }

  /** 휴장 → 다음 거래일 개장 */
  nextDay() {
    if (this.status !== 'intermission') return { ok: false, error: '휴장 상태가 아닙니다' };
    if (this.currentDay >= this.settings.totalDays) return { ok: false, error: '마지막 거래일입니다' };
    this.openDay(this.currentDay + 1);
    this.addNews(`🔔 ${this.currentDay}거래일 개장! (총 ${this.settings.totalDays}일)`, 'alert');
    this.broadcastStocks();
    this.broadcastGame();
    return { ok: true };
  }

  // ───────────────────────── 틱 루프 ─────────────────────────

  tick() {
    // 거래일 진행 중(running)에만 가격이 움직인다. lobby/paused/intermission/ended는 완전 동결.
    if (this.status !== 'running') return;
    if (now() >= this.endsAt) { this.closeDay(); return; }
    this.runTick();
  }

  runTick() {
    const ts = now();
    const bucket = Math.floor(ts / 1000 / this.candleSec) * this.candleSec;
    const prices = {};
    const delist = {};
    let stocksDirty = false;
    const dt = this.tickSec;
    const trendWin = this.secToTicks(TREND_WINDOW_SEC);
    const coolTicks = this.secToTicks(BEHAVIOR_COOLDOWN_SEC);

    for (const s of this.stocks.values()) {
      if (s.delisted) continue;
      if (s.delistTicks != null) {
        s.delistTicks -= 1;
        if (s.delistTicks <= 0) {
          this.executeDelist(s);
          prices[s.symbol] = 0;
          stocksDirty = true;
          continue;
        }
        delist[s.symbol] = s.delistTicks * this.tickSec; // 클라이언트에는 초 단위로
      }
      if (s.halted) continue;

      // 1) 추세선(적정가)을 시나리오 기울기대로 이동
      const planDrift = s.plannedDrift + s.drift; // 시나리오 + 종목 고유 바이어스
      s.fairValue = Math.max(1, s.fairValue * Math.exp(planDrift * dt));

      // 2) 행동 이벤트: 한쪽으로만 흐르지 않게 차익실현/패닉셀을 확률적으로 끼워넣음
      this.maybeBehavior(s, trendWin, coolTicks);

      // 3) modifier 스택(급등/급락/시장이벤트/행동이벤트) 합산
      let drift = planDrift;
      let vol = s.volatility * s.dayVolMul;
      s.modifiers = s.modifiers.filter(m => m.ticksLeft-- > 0);
      for (const m of s.modifiers) { drift += m.driftDelta; vol *= m.volMul; }

      // 4) 추세선으로의 평균회귀(로그공간) — 추세선에서 벌어질수록 되돌림이 커짐
      const gap = Math.log(s.fairValue / s.price); // >0 이면 가격이 추세선보다 낮음 → 상승 압력
      drift += KAPPA * gap;

      // 5) GBM 1스텝 (dt초): μ·dt, σ·√dt
      const mu = drift * dt;
      const sigma = Math.min(vol * Math.sqrt(dt), MAX_SIGMA_STEP);
      const z = gaussian();
      s.price = Math.max(1, s.price * Math.exp((mu - (sigma * sigma) / 2) + sigma * z));
      const p = Math.round(s.price);
      prices[s.symbol] = p;
      this.recordPrice(s, p, bucket);
    }

    const payload = { ts, prices };
    if (Object.keys(delist).length) payload.delist = delist;
    this.io.emit(EV.TICK, payload);
    if (stocksDirty) this.broadcastStocks();

    this.tickCount++;
    this.broadcastLeaderboard();
  }

  /**
   * 행동 이벤트 — 추세 중간에 끼어드는 드라마. 한쪽으로 쏠리지 않도록 상/하 대칭으로 둔다.
   *  · 단기 급락 → 패닉셀(하락) / 단기 급등 → 추격매수(상승)   [모멘텀]
   *  · 추세선 대비 과열 → 차익실현(하락) / 과매도 → 저가매수(상승)  [회귀 가속]
   * 쿨다운으로 연발 방지.
   */
  maybeBehavior(s, trendWin, coolTicks) {
    if (s.behaviorCooldown > 0) { s.behaviorCooldown--; return; }
    const n = s.spark.length;
    const past = s.spark[Math.max(0, n - 1 - trendWin)] || s.price;
    const shortRet = (s.price - past) / past;        // 단기 수익률
    const dev = (s.price - s.fairValue) / s.fairValue; // 추세선 대비 괴리

    // 모멘텀: 단기 급락 → 패닉셀(투매), 단기 급등 → 추격매수(과열). (자동 이벤트라 뉴스는 띄우지 않음)
    if (shortRet <= -PANIC_DROP && Math.random() < PANIC_PROB) {
      s.modifiers.push({ driftDelta: -MOMENTUM_DRIFT, volMul: 1.5, ticksLeft: this.secToTicks(12) });
      s.behaviorCooldown = coolTicks;
      return;
    }
    if (shortRet >= PANIC_DROP && Math.random() < PANIC_PROB) {
      s.modifiers.push({ driftDelta: +MOMENTUM_DRIFT, volMul: 1.5, ticksLeft: this.secToTicks(12) });
      s.behaviorCooldown = coolTicks;
      return;
    }
    // 회귀 가속: 과열 → 차익실현(눌림목), 과매도 → 저가매수(반등)
    if ((dev >= PROFIT_DEV || shortRet >= PROFIT_RUN) && Math.random() < PROFIT_PROB) {
      s.modifiers.push({ driftDelta: -REVERT_DRIFT, volMul: 1.15, ticksLeft: this.secToTicks(12) });
      s.behaviorCooldown = coolTicks;
      return;
    }
    if ((dev <= -PROFIT_DEV || shortRet <= -PROFIT_RUN) && Math.random() < PROFIT_PROB) {
      s.modifiers.push({ driftDelta: +REVERT_DRIFT, volMul: 1.15, ticksLeft: this.secToTicks(12) });
      s.behaviorCooldown = coolTicks;
    }
  }

  /** 캔들/스파크라인에 체결가 반영 (틱·즉시점프 공용) */
  recordPrice(s, p, bucket) {
    if (!s.candle || s.candle.time !== bucket) {
      if (s.candle) {
        s.candles.push(s.candle);
        if (s.candles.length > MAX_CANDLES) s.candles.shift();
      }
      s.candle = { time: bucket, open: p, high: p, low: p, close: p };
    } else {
      if (p > s.candle.high) s.candle.high = p;
      if (p < s.candle.low) s.candle.low = p;
      s.candle.close = p;
    }
    s.spark.push(p);
    if (s.spark.length > SPARK_LEN) s.spark.shift();
  }

  // ───────────────────────── 참가자 ─────────────────────────

  join(nickname) {
    nickname = String(nickname || '').trim().slice(0, 12);
    if (nickname.length < 1) return { ok: false, error: '닉네임을 입력하세요 (1~12자)' };
    for (const p of this.players.values())
      if (p.nickname === nickname) return { ok: false, error: '이미 사용 중인 닉네임입니다' };
    const player = {
      token: rid(16),
      nickname,
      cash: this.settings.initialCash,
      initialCash: this.settings.initialCash,
      holdings: {}, // symbol -> { qty, avgPrice }
      trades: [],
      joinedAt: now(),
    };
    this.players.set(player.token, player);
    this.addNews(`👋 ${nickname} 님 참가! (현재 ${this.players.size}명)`, 'info');
    this.broadcastLeaderboard();
    return { ok: true, token: player.token, player: this.playerState(player) };
  }

  kick(token) {
    const p = this.players.get(token);
    if (!p) return { ok: false, error: '없는 참가자' };
    this.players.delete(token);
    this.io.to('p:' + token).emit(EV.KICKED, {});
    this.addNews(`🚪 ${p.nickname} 님이 퇴장되었습니다`, 'info');
    this.broadcastLeaderboard();
    return { ok: true };
  }

  /**
   * 시장가 즉시 체결. Node 단일 스레드 + 동기 처리이므로 잔고 갱신은 원자적.
   * 모든 검증은 서버에서 수행.
   */
  trade(token, symbol, side, qty) {
    const player = this.players.get(token);
    if (!player) return { ok: false, error: '참가자 정보가 없습니다. 다시 접속해주세요' };
    if (this.status !== 'running') {
      const why = { lobby: '게임 시작 전입니다', paused: '장 일시정지 중입니다', intermission: '휴장 중입니다 — 다음 거래일을 기다려주세요', ended: '게임이 종료되었습니다' };
      return { ok: false, error: why[this.status] || '지금은 거래할 수 없습니다' };
    }
    const s = this.stocks.get(String(symbol || '').toUpperCase());
    if (!s) return { ok: false, error: '없는 종목입니다' };
    if (s.delisted) return { ok: false, error: '상장폐지된 종목입니다' };
    if (s.halted) return { ok: false, error: '거래정지 종목입니다' };
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) return { ok: false, error: '수량이 올바르지 않습니다' };

    const price = Math.round(s.price);
    const amount = price * qty;
    const fee = Math.floor(amount * this.settings.feeRate);

    if (side === 'buy') {
      const cost = amount + fee;
      if (player.cash < cost) return { ok: false, error: '잔고가 부족합니다' };
      player.cash -= cost;
      const h = player.holdings[s.symbol] || (player.holdings[s.symbol] = { qty: 0, avgPrice: 0 });
      h.avgPrice = Math.round((h.avgPrice * h.qty + amount) / (h.qty + qty));
      h.qty += qty;
    } else if (side === 'sell') {
      const h = player.holdings[s.symbol];
      if (!h || h.qty < qty) return { ok: false, error: '보유 수량이 부족합니다' };
      h.qty -= qty;
      player.cash += amount - fee;
      if (h.qty === 0) delete player.holdings[s.symbol];
    } else {
      return { ok: false, error: '잘못된 주문 종류입니다' };
    }

    const trade = { id: rid(6), ts: now(), symbol: s.symbol, name: s.name, side, qty, price, fee };
    player.trades.unshift(trade);
    if (player.trades.length > MAX_TRADES) player.trades.pop();
    this.emitMe(player);
    this.scheduleLeaderboard(); // 틱 간격이 길어도 거래 직후 순위 반영
    return { ok: true, trade };
  }

  valuation(player) {
    let v = player.cash;
    for (const [sym, h] of Object.entries(player.holdings)) {
      const s = this.stocks.get(sym);
      if (s && !s.delisted) v += Math.round(s.price) * h.qty;
      // 상폐 종목은 0원 평가
    }
    return v;
  }

  rankings() {
    const list = [...this.players.values()].map(p => ({
      token: p.token,
      nickname: p.nickname,
      total: this.valuation(p),
      initialCash: p.initialCash,
    }));
    list.sort((a, b) => b.total - a.total);
    return list.map((p, i) => ({
      rank: i + 1,
      token: p.token,
      nickname: p.nickname,
      total: p.total,
      returnPct: p.initialCash ? ((p.total - p.initialCash) / p.initialCash) * 100 : 0,
    }));
  }

  playerState(player) {
    const ranks = this.rankings();
    const mine = ranks.find(r => r.token === player.token);
    return {
      nickname: player.nickname,
      cash: player.cash,
      initialCash: player.initialCash,
      holdings: Object.entries(player.holdings).map(([sym, h]) => ({
        symbol: sym,
        name: this.stocks.get(sym)?.name || sym,
        qty: h.qty,
        avgPrice: h.avgPrice,
      })),
      trades: player.trades,
      total: mine?.total ?? this.valuation(player),
      returnPct: mine?.returnPct ?? 0,
      rank: mine?.rank ?? null,
      totalPlayers: this.players.size,
    };
  }

  emitMe(player) {
    this.io.to('p:' + player.token).emit(EV.ME, this.playerState(player));
  }

  // ───────────────────────── 게임 제어 ─────────────────────────

  gameAction(action) {
    switch (action) {
      case 'start':
        if (this.status === 'running') return { ok: false, error: '이미 진행 중' };
        if (this.status === 'paused') return this.gameAction('resume');
        if (this.status === 'intermission') return this.nextDay();
        if (this.status === 'ended') this.reset({ silent: true });
        this.openDay(1); // 1거래일 개장 (시나리오/추세선/등락률 기준 초기화)
        this.addNews(`🔔 게임 시작! 총 ${this.settings.totalDays}거래일, 하루 ${this.settings.durationMin}분 — 최고의 수익률에 도전하세요`, 'alert');
        this.broadcastStocks();
        break;
      case 'pause': // 서킷브레이커: 가격틱 + 거래 + 타이머 전부 동결
        if (this.status !== 'running') return { ok: false, error: '진행 중이 아닙니다' };
        this.remainingMs = Math.max(0, this.endsAt - now());
        this.status = 'paused';
        this.addNews('⏸ 서킷브레이커 발동 — 장이 일시정지되었습니다', 'alert');
        break;
      case 'resume':
        if (this.status !== 'paused') return { ok: false, error: '일시정지 상태가 아닙니다' };
        this.endsAt = now() + this.remainingMs;
        this.status = 'running';
        this.addNews('▶️ 장 재개! 거래가 다시 가능합니다', 'alert');
        break;
      case 'end':
        if (this.status === 'ended') return { ok: false, error: '이미 종료됨' };
        this.endGame();
        break;
      case 'reset':
        this.reset();
        break;
      default:
        return { ok: false, error: '알 수 없는 동작' };
    }
    this.broadcastGame();
    return { ok: true };
  }

  endGame() {
    this.status = 'ended';
    this.remainingMs = 0;
    const rankings = this.rankings().map(({ token, ...r }) => r);
    this.io.emit(EV.FINAL, { rankings });
    this.addNews('🏁 게임 종료! 최종 순위를 확인하세요', 'alert');
    this.broadcastGame();
    for (const p of this.players.values()) this.emitMe(p);
  }

  reset(opts = {}) {
    this.status = 'lobby';
    this.currentDay = 0;
    this.endsAt = null;
    this.remainingMs = this.settings.durationMin * 60_000;
    this.tickCount = 0;
    this.news = [];
    for (const s of this.stocks.values()) {
      s.price = s.initialPrice;
      s.basePrice = s.initialPrice;
      s.fairValue = s.initialPrice;
      s.dayScenario = null;
      s.behaviorCooldown = 0;
      s.modifiers = [];
      s.halted = false;
      s.delisted = false;
      s.delistTicks = null;
      s.candles = [];
      s.candle = null;
      s.spark = [s.initialPrice];
      // 시나리오(scenario)는 보존 — 다음 게임에도 같은 세팅을 재사용
    }
    for (const p of this.players.values()) {
      p.cash = this.settings.initialCash;
      p.initialCash = this.settings.initialCash;
      p.holdings = {};
      p.trades = [];
    }
    if (!opts.silent) {
      this.io.emit(EV.NEWS_CLEAR, {}); // 클라이언트가 쌓아둔 뉴스 이력도 초기화
      this.addNews('🔄 게임이 리셋되었습니다. 곧 새 게임이 시작됩니다!', 'alert');
      this.broadcastStocks();
      this.broadcastGame();
      this.broadcastLeaderboard();
      for (const p of this.players.values()) this.emitMe(p);
    }
  }

  updateSettings({ initialCash, durationMin, feeRate, tickSec, totalDays }) {
    if (initialCash != null && Number(initialCash) >= 1000)
      this.settings.initialCash = Math.round(Number(initialCash));
    if (durationMin != null && Number(durationMin) >= 1)
      this.settings.durationMin = Math.min(240, Math.round(Number(durationMin)));
    if (feeRate != null && Number(feeRate) >= 0)
      this.settings.feeRate = Math.min(0.1, Number(feeRate));
    if (totalDays != null && Number.isFinite(Number(totalDays)))
      this.settings.totalDays = clampDays(totalDays);
    if (tickSec != null) {
      const v = clampTickSec(tickSec);
      if (v != null && v !== this.tickSec) {
        this.tickSec = v;
        this.startTickTimer();
        this.broadcastStocks(); // delistIn(초)은 tickSec에 의존
      }
    }
    if (this.status === 'lobby') {
      this.remainingMs = this.settings.durationMin * 60_000;
      // 아직 거래 전이므로 대기 중 참가자 잔고를 새 초기자금으로 갱신
      for (const p of this.players.values()) {
        p.cash = this.settings.initialCash;
        p.initialCash = this.settings.initialCash;
        this.emitMe(p);
      }
    }
    this.broadcastGame();
    return { ok: true };
  }

  // ───────────────────────── 뉴스 ─────────────────────────

  addNews(text, kind = 'info') {
    const item = { id: rid(4), text: String(text).slice(0, 120), ts: now(), kind };
    this.news.push(item);
    if (this.news.length > MAX_NEWS) this.news.shift();
    this.io.emit(EV.NEWS, item);
    return item;
  }

  clearNews() {
    this.news = [];
    this.io.emit(EV.NEWS_CLEAR, {});
    return { ok: true };
  }

  adminNews(text, effect) {
    if (!text || !String(text).trim()) return { ok: false, error: '뉴스 내용을 입력하세요' };
    this.addNews('📰 ' + String(text).trim(), 'alert');
    if (effect && effect.symbol) {
      this.surgeStock(String(effect.symbol).toUpperCase(), effect.direction, effect.strength, effect.durationSec);
    }
    return { ok: true };
  }

  // ───────────────────────── 브로드캐스트 / 직렬화 ─────────────────────────

  stockList() {
    return [...this.stocks.values()].map(s => ({
      symbol: s.symbol,
      name: s.name,
      price: s.delisted ? 0 : Math.round(s.price),
      basePrice: s.basePrice,
      initialPrice: s.initialPrice,
      volatility: s.volatility,
      drift: s.drift,
      halted: s.halted,
      delisted: s.delisted,
      delistIn: s.delistTicks != null ? s.delistTicks * this.tickSec : null,
      scenario: { ...s.scenario },
      dayScenario: s.dayScenario ? { ...s.dayScenario } : null,
    }));
  }

  gameState() {
    return {
      status: this.status,
      endsAt: this.endsAt,
      remainingMs: this.status === 'running' ? Math.max(0, this.endsAt - now()) : this.remainingMs,
      settings: this.settings,
      tickSec: this.tickSec,
      candleSec: this.candleSec,
      minTickSec: MIN_TICK_SEC,
      maxTickSec: MAX_TICK_SEC,
      currentDay: this.currentDay,
      totalDays: this.settings.totalDays,
    };
  }

  broadcastStocks() { this.io.emit(EV.STOCKS, this.stockList()); }

  /** 연속 주문 폭주 시 리더보드 재계산을 500ms로 묶어서 1회만 */
  scheduleLeaderboard() {
    if (this._lbPending) return;
    this._lbPending = setTimeout(() => {
      this._lbPending = null;
      this.broadcastLeaderboard();
    }, 500);
  }
  broadcastGame() { this.io.emit(EV.GAME, this.gameState()); }

  broadcastLeaderboard() {
    const ranks = this.rankings();
    this.io.emit(EV.LEADERBOARD, {
      top: ranks.slice(0, 10).map(({ token, ...r }) => r),
      totalPlayers: this.players.size,
    });
    // 접속 중인 참가자에게만 개인 상태 푸시 (순위 갱신용)
    for (const r of ranks) {
      const room = this.io.sockets.adapter.rooms.get('p:' + r.token);
      if (room && room.size > 0) this.emitMe(this.players.get(r.token));
    }
  }

  syncPayload() {
    return {
      game: this.gameState(),
      stocks: this.stockList(),
      sparks: Object.fromEntries([...this.stocks.values()].map(s => [s.symbol, s.spark])),
      news: this.news.filter(n => now() - n.ts < NEWS_TTL_MS).slice(-5),
      newsHistory: this.news, // 참가자 뉴스 탭용 전체 이력 (최근 MAX_NEWS개)
      leaderboard: { top: this.rankings().slice(0, 10).map(({ token, ...r }) => r), totalPlayers: this.players.size },
    };
  }

  chartHistory(symbol) {
    const s = this.stocks.get(String(symbol || '').toUpperCase());
    if (!s) return { ok: false, error: '없는 종목' };
    const candles = s.candle ? [...s.candles, s.candle] : [...s.candles];
    return { ok: true, candles, price: Math.round(s.price) };
  }

  adminState() {
    const ranks = this.rankings();
    return {
      players: ranks.map(r => ({
        ...r,
        cash: this.players.get(r.token)?.cash ?? 0,
        online: (this.io.sockets.adapter.rooms.get('p:' + r.token)?.size ?? 0) > 0,
      })),
    };
  }

  // ───────────────────────── 스냅샷 (state.json) ─────────────────────────

  serialize() {
    return {
      savedAt: now(),
      status: this.status,
      endsAt: this.endsAt,
      remainingMs: this.status === 'running' ? Math.max(0, this.endsAt - now()) : this.remainingMs,
      settings: this.settings,
      tickSec: this.tickSec,
      currentDay: this.currentDay,
      tickCount: this.tickCount,
      news: this.news,
      stocks: [...this.stocks.values()],
      players: [...this.players.values()],
    };
  }

  /** 구버전 스냅샷에 새 가격엔진/시나리오 필드를 보강 */
  hydrateStock(s) {
    if (s.fairValue == null) s.fairValue = s.price ?? s.initialPrice;
    if (s.plannedDrift == null) s.plannedDrift = 0;
    if (s.dayVolMul == null) s.dayVolMul = 1;
    if (s.behaviorCooldown == null) s.behaviorCooldown = 0;
    if (s.dayScenario === undefined) s.dayScenario = null;
    if (!s.scenario || !TREND_PRESETS[s.scenario.trend] || !VOL_PRESETS[s.scenario.vol])
      s.scenario = { trend: 'flat', vol: 'mid' };
    if (!Array.isArray(s.modifiers)) s.modifiers = [];
    return s;
  }

  restore(snap) {
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
      const restoredTick = clampTickSec(snap.tickSec);
      if (restoredTick != null && restoredTick !== this.tickSec) {
        this.tickSec = restoredTick;
        this.startTickTimer();
      }
      this.tickCount = snap.tickCount || 0;
      this.currentDay = snap.currentDay || 0;
      this.news = snap.news || [];
      this.stocks = new Map((snap.stocks || []).map(s => [s.symbol, this.hydrateStock(s)]));
      this.players = new Map((snap.players || []).map(p => [p.token, p]));
      this.remainingMs = snap.remainingMs ?? this.settings.durationMin * 60_000;
      // 진행 중이던 거래일은 일시정지 상태로 복구 → 관리자가 '재개'로 이어감. 휴장은 그대로.
      this.status = snap.status === 'running' ? 'paused' : (snap.status || 'lobby');
      this.endsAt = null;
      return true;
    } catch (e) {
      console.error('스냅샷 복구 실패:', e.message);
      return false;
    }
  }
}
