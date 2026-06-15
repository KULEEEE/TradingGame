/**
 * Socket.IO 이벤트 명세 — 서버와 클라이언트가 공유하는 단일 정의.
 * (서버: import, 클라이언트: <script type="module"> 에서 /shared/events.js 로 import)
 *
 * ───────────────────────── 클라이언트 → 서버 (ack 콜백 사용) ─────────────────────────
 * sync            ()                          → { game, stocks, news, newsHistory, leaderboard, joinUrl }
 *                 news = 티커용(TTL 내 최근 5건), newsHistory = 뉴스 탭용 전체 이력
 * join            { nickname }                → { ok, token?, player?, error? }
 * resume          { token }                   → { ok, player?, error? }
 * trade           { symbol, side:'buy'|'sell', qty } → { ok, trade?, error? }   * 토큰은 소켓에 바인딩
 * chart:history   { symbol }                  → { ok, candles:[{time,open,high,low,close}], price }
 * screen:hello    ()                          → { qrDataUrl, joinUrl }
 *
 * ── 관리자 (admin:login 후 같은 소켓에서만 허용) ──
 * admin:login        { password }             → { ok }
 * admin:game         { action:'start'|'pause'|'resume'|'end'|'reset' } → { ok, error? }
 * admin:settings     { initialCash?, durationMin?, feeRate?, tickSec? } → { ok }   * tickSec: 가격 변동 주기(초, 1~60)
 * admin:stock:add    { symbol, name, initialPrice, volatility, drift } → { ok, error? }
 * admin:stock:update { symbol, volatility?, drift? }                   → { ok }
 * admin:stock:remove { symbol }   목록에서 완전 삭제 (보유분은 현재가로 강제 매도) → { ok }
 * admin:stock:halt   { symbol, halted:boolean }                        → { ok }
 * admin:stock:jump   { symbol, pct }            한 틱 즉시 ±N%        → { ok }
 * admin:stock:surge  { symbol, direction:1|-1, strength:'weak'|'mid'|'strong', durationSec } → { ok }
 * admin:market       { direction:1|-1, strength, durationSec }         → { ok }   * 전 종목 modifier
 * admin:delist       { symbol, immediate:boolean }                     → { ok }
 * admin:news         { text, effect?:{ symbol, direction, strength, durationSec } } → { ok }
 * admin:news:clear   ()                                                → { ok }   * 모든 화면 티커 비움
 * admin:kick         { token }                                         → { ok }
 * admin:state        ()                        → { players:[{token,nickname,cash,total,returnPct,online}] }
 * admin:scenario     { symbol, trend, vol }    다음 거래일 추세/변동성 프리셋 세팅(휴장·대기 중) → { ok }
 * admin:nextDay      ()                        휴장 → 다음 거래일 개장 → { ok, error? }
 *
 * ───────────────────────── 서버 → 클라이언트 (broadcast) ─────────────────────────
 * tick         { ts, prices:{SYM:int}, delist?:{SYM:secLeft} }   매초. 변동된 종목 가격만.
 * stocks       [ {symbol,name,price,basePrice,initialPrice,volatility,drift,halted,delisted,delistIn,scenario:{trend,vol}} ]
 *              basePrice = 전일 종가(등락률 기준). 종목 메타 변경 시(추가/정지/상폐/파라미터/시나리오)만 전체 전송.
 * game         { status:'lobby'|'running'|'paused'|'intermission'|'ended', endsAt, remainingMs, settings, tickSec, candleSec, minTickSec, maxTickSec, currentDay, totalDays }
 *              status=intermission → 장 마감(휴장). 관리자가 다음날 시나리오 세팅 후 개장.
 * news         { id, text, ts, kind:'info'|'alert' }
 * news:clear   {}                                       관리자가 뉴스 전체 삭제 / 게임 리셋 시
 * joinurl      { joinUrl, qrDataUrl }                   참가 URL 변경 시 (터널 연결 등) 스크린 QR 갱신
 * leaderboard  { top:[{nickname,total,returnPct}], totalPlayers }   2초마다
 * final        { rankings:[{rank,nickname,total,returnPct}] }       게임 종료 시
 *
 * ── 개인 룸(p:{token}) 전용 ──
 * me           { nickname, cash, initialCash, holdings:[{symbol,name,qty,avgPrice}], trades, total, returnPct, rank }
 * kicked       {}
 */
export const EV = {
  // client → server
  SYNC: 'sync',
  JOIN: 'join',
  RESUME: 'resume',
  TRADE: 'trade',
  CHART: 'chart:history',
  SCREEN_HELLO: 'screen:hello',
  // admin
  ADMIN_LOGIN: 'admin:login',
  ADMIN_GAME: 'admin:game',
  ADMIN_SETTINGS: 'admin:settings',
  ADMIN_STOCK_ADD: 'admin:stock:add',
  ADMIN_STOCK_UPDATE: 'admin:stock:update',
  ADMIN_STOCK_REMOVE: 'admin:stock:remove',
  ADMIN_STOCK_HALT: 'admin:stock:halt',
  ADMIN_STOCK_JUMP: 'admin:stock:jump',
  ADMIN_SURGE: 'admin:stock:surge',
  ADMIN_MARKET: 'admin:market',
  ADMIN_DELIST: 'admin:delist',
  ADMIN_NEWS: 'admin:news',
  ADMIN_NEWS_CLEAR: 'admin:news:clear',
  ADMIN_KICK: 'admin:kick',
  ADMIN_STATE: 'admin:state',
  ADMIN_SCENARIO: 'admin:scenario',   // { symbol, trend, vol } 다음 거래일 추세 세팅
  ADMIN_NEXT_DAY: 'admin:nextDay',    // 휴장 → 다음 거래일 개장
  // server → client
  TICK: 'tick',
  STOCKS: 'stocks',
  GAME: 'game',
  NEWS: 'news',
  NEWS_CLEAR: 'news:clear',
  JOIN_URL: 'joinurl',
  LEADERBOARD: 'leaderboard',
  FINAL: 'final',
  ME: 'me',
  KICKED: 'kicked',
};

/**
 * 급등/급락 강도 → 초당 드리프트. 서버가 틱 간격(tickSec)에 맞게 μ·dt로 스케일해서 적용.
 * 지속시간 D초 동안의 누적 변화 ≈ drift·D (틱 간격과 무관). 변동성 노이즈를 확실히
 * 뚫고 방향성이 보이도록 충분히 크게 잡는다. (예: mid·30초 ≈ +36%)
 */
export const STRENGTH_DRIFT = { weak: 0.005, mid: 0.012, strong: 0.025 };

/**
 * 거래일 추세 프리셋 — 휴장 중 종목별로 "다음날 어떻게 흐를지"를 미리 세팅한다.
 * daily = 하루 장(durationMin) 동안 추세선(적정가)의 목표 변화율. 서버가 장 길이로 나눠
 * 초당 드리프트로 환산하므로 장 시간이 길든 짧든 하루 추세폭은 일정하다.
 */
export const TREND_PRESETS = {
  strong_up:   { label: '강한상승', emoji: '🚀', daily:  0.30 },
  up:          { label: '상승',     emoji: '📈', daily:  0.12 },
  flat:        { label: '횡보',     emoji: '➡️', daily:  0.00 },
  down:        { label: '하락',     emoji: '📉', daily: -0.12 },
  strong_down: { label: '강한하락', emoji: '💥', daily: -0.28 },
};

/** 거래일 변동성 프리셋 — 종목 기본 변동성에 곱해지는 배수 */
export const VOL_PRESETS = {
  low:  { label: '낮음', mul: 0.6 },
  mid:  { label: '보통', mul: 1.0 },
  high: { label: '높음', mul: 1.8 },
};
