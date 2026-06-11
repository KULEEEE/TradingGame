import crypto from 'node:crypto';
import { EV, STRENGTH_DRIFT } from '../shared/events.js';

const TICK_SEC = Math.max(1, Number(process.env.TICK_SEC) || 10); // 가격 틱 간격 (초)
const TICK_MS = TICK_SEC * 1000;
const CANDLE_SEC = Math.max(10, TICK_SEC * 6);  // 캔들 1개 = 6틱 (기본 1분봉)
const MAX_CANDLES = 360;
const MAX_TRADES = 100;     // 참가자별 거래내역 보관 수
const MAX_NEWS = 30;
const NEWS_TTL_MS = 120_000; // 티커/재접속 시 이 시간 지난 뉴스는 내려주지 않음
const SPARK_LEN = 90;       // 스파크라인 포인트 수
const DELIST_COUNTDOWN_SEC = 30; // 상폐 카운트다운 (초)

// 시뮬레이션 파라미터(drift/volatility/STRENGTH_DRIFT)는 모두 "초당" 값.
// 한 틱이 TICK_SEC초이므로 GBM 1스텝은 μ·dt, σ·√dt 로 스케일한다.
const secToTicks = (sec) => Math.max(1, Math.round(sec / TICK_SEC));

export const DEFAULT_SETTINGS = { initialCash: 10_000_000, durationMin: 20, feeRate: 0 };

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
    this.status = 'lobby'; // lobby | running | paused | ended
    this.endsAt = null;
    this.remainingMs = this.settings.durationMin * 60_000;
    this.stocks = new Map();   // symbol -> stock
    this.players = new Map();  // token -> player
    this.news = [];
    this.tickCount = 0;
    for (const def of stockDefs) this.addStock(def, { silent: true });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // 틱이 길어도 게임 종료는 1초 단위로 체크
    this.endTimer = setInterval(() => {
      if (this.status === 'running' && now() >= this.endsAt) this.endGame();
    }, 1000);
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
      basePrice: initialPrice, // 등락률 기준가 (게임 시작 시 재설정)
      price: initialPrice,     // 내부적으로 float 유지, 송출 시 반올림
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
    this.recordPrice(s, rounded, Math.floor(ts / 1000 / CANDLE_SEC) * CANDLE_SEC);
    this.io.emit(EV.TICK, { ts, prices: { [s.symbol]: rounded } });
    return { ok: true };
  }

  surgeStock(symbol, direction, strength, durationSec) {
    const s = this.stocks.get(symbol);
    if (!s || s.delisted) return { ok: false, error: '없는 종목이거나 상장폐지됨' };
    const d = STRENGTH_DRIFT[strength] ?? STRENGTH_DRIFT.mid;
    const dir = direction >= 0 ? 1 : -1;
    const ticks = secToTicks(Math.max(5, Math.min(300, Number(durationSec) || 30)));
    s.modifiers.push({ driftDelta: dir * d, volMul: 1.3, ticksLeft: ticks });
    return { ok: true };
  }

  marketEvent(direction, strength, durationSec) {
    const d = STRENGTH_DRIFT[strength] ?? STRENGTH_DRIFT.mid;
    const dir = direction >= 0 ? 1 : -1;
    const ticks = secToTicks(Math.max(5, Math.min(300, Number(durationSec) || 30)));
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
    const ticks = secToTicks(DELIST_COUNTDOWN_SEC);
    s.delistTicks = ticks;
    s.halted = false; // 탈출 기회를 줘야 하므로 거래는 열어둠
    s.modifiers.push({ driftDelta: -0.06, volMul: 2, ticksLeft: ticks });
    this.addNews(`🚨 [상장폐지 경고] ${s.name}(${s.symbol}) ${ticks * TICK_SEC}초 후 상장폐지! 지금이 마지막 탈출 기회`, 'alert');
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

  // ───────────────────────── 틱 루프 ─────────────────────────

  tick() {
    if (this.status === 'running' && now() >= this.endsAt) { this.endGame(); return; }
    // lobby에서도 가격은 움직임(스크린 데모용). paused/ended는 완전 동결.
    if (this.status !== 'lobby' && this.status !== 'running') return;
    this.runTick();
  }

  runTick() {

    const ts = now();
    const bucket = Math.floor(ts / 1000 / CANDLE_SEC) * CANDLE_SEC;
    const prices = {};
    const delist = {};
    let stocksDirty = false;

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
        delist[s.symbol] = s.delistTicks * TICK_SEC; // 클라이언트에는 초 단위로
      }
      if (s.halted) continue;

      // modifier 스택: 만료 제거 후 기본 파라미터에 합산 (초당 값)
      let drift = s.drift;
      let vol = s.volatility;
      s.modifiers = s.modifiers.filter(m => m.ticksLeft-- > 0);
      for (const m of s.modifiers) { drift += m.driftDelta; vol *= m.volMul; }

      // GBM 1스텝 (dt = TICK_SEC초): μ·dt, σ·√dt
      const mu = drift * TICK_SEC;
      const sigma = Math.min(vol * Math.sqrt(TICK_SEC), 0.6);
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
      const why = { lobby: '게임 시작 전입니다', paused: '장 일시정지 중입니다', ended: '게임이 종료되었습니다' };
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
        if (this.status === 'ended') this.reset({ silent: true });
        for (const s of this.stocks.values()) if (!s.delisted) s.basePrice = Math.round(s.price);
        this.status = 'running';
        this.endsAt = now() + this.settings.durationMin * 60_000;
        this.remainingMs = this.settings.durationMin * 60_000;
        this.addNews(`🔔 게임 시작! ${this.settings.durationMin}분 동안 최고의 수익률에 도전하세요`, 'alert');
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
    this.endsAt = null;
    this.remainingMs = this.settings.durationMin * 60_000;
    this.tickCount = 0;
    this.news = [];
    for (const s of this.stocks.values()) {
      s.price = s.initialPrice;
      s.basePrice = s.initialPrice;
      s.modifiers = [];
      s.halted = false;
      s.delisted = false;
      s.delistTicks = null;
      s.candles = [];
      s.candle = null;
      s.spark = [s.initialPrice];
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

  updateSettings({ initialCash, durationMin, feeRate }) {
    if (initialCash != null && Number(initialCash) >= 1000)
      this.settings.initialCash = Math.round(Number(initialCash));
    if (durationMin != null && Number(durationMin) >= 1)
      this.settings.durationMin = Math.min(240, Math.round(Number(durationMin)));
    if (feeRate != null && Number(feeRate) >= 0)
      this.settings.feeRate = Math.min(0.1, Number(feeRate));
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
      delistIn: s.delistTicks != null ? s.delistTicks * TICK_SEC : null,
    }));
  }

  gameState() {
    return {
      status: this.status,
      endsAt: this.endsAt,
      remainingMs: this.status === 'running' ? Math.max(0, this.endsAt - now()) : this.remainingMs,
      settings: this.settings,
      tickSec: TICK_SEC,
      candleSec: CANDLE_SEC,
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
      tickCount: this.tickCount,
      news: this.news,
      stocks: [...this.stocks.values()],
      players: [...this.players.values()],
    };
  }

  restore(snap) {
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
      this.tickCount = snap.tickCount || 0;
      this.news = snap.news || [];
      this.stocks = new Map((snap.stocks || []).map(s => [s.symbol, s]));
      this.players = new Map((snap.players || []).map(p => [p.token, p]));
      this.remainingMs = snap.remainingMs ?? this.settings.durationMin * 60_000;
      // 진행 중이던 게임은 일시정지 상태로 복구 → 관리자가 '재개'로 이어감
      this.status = snap.status === 'running' ? 'paused' : (snap.status || 'lobby');
      this.endsAt = null;
      return true;
    } catch (e) {
      console.error('스냅샷 복구 실패:', e.message);
      return false;
    }
  }
}
