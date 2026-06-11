/**
 * Socket.IO 이벤트 명세 — 서버와 클라이언트가 공유하는 단일 정의.
 * (서버: import, 클라이언트: <script type="module"> 에서 /shared/events.js 로 import)
 *
 * ───────────────────────── 클라이언트 → 서버 (ack 콜백 사용) ─────────────────────────
 * sync            ()                          → { game, stocks, news, leaderboard, joinUrl }
 * join            { nickname }                → { ok, token?, player?, error? }
 * resume          { token }                   → { ok, player?, error? }
 * trade           { symbol, side:'buy'|'sell', qty } → { ok, trade?, error? }   * 토큰은 소켓에 바인딩
 * chart:history   { symbol }                  → { ok, candles:[{time,open,high,low,close}], price }
 * screen:hello    ()                          → { qrDataUrl, joinUrl }
 *
 * ── 관리자 (admin:login 후 같은 소켓에서만 허용) ──
 * admin:login        { password }             → { ok }
 * admin:game         { action:'start'|'pause'|'resume'|'end'|'reset' } → { ok, error? }
 * admin:settings     { initialCash?, durationMin?, feeRate? }          → { ok }
 * admin:stock:add    { symbol, name, initialPrice, volatility, drift } → { ok, error? }
 * admin:stock:update { symbol, volatility?, drift? }                   → { ok }
 * admin:stock:halt   { symbol, halted:boolean }                        → { ok }
 * admin:stock:jump   { symbol, pct }            한 틱 즉시 ±N%        → { ok }
 * admin:stock:surge  { symbol, direction:1|-1, strength:'weak'|'mid'|'strong', durationSec } → { ok }
 * admin:market       { direction:1|-1, strength, durationSec }         → { ok }   * 전 종목 modifier
 * admin:delist       { symbol, immediate:boolean }                     → { ok }
 * admin:news         { text, effect?:{ symbol, direction, strength, durationSec } } → { ok }
 * admin:news:clear   ()                                                → { ok }   * 모든 화면 티커 비움
 * admin:kick         { token }                                         → { ok }
 * admin:state        ()                        → { players:[{token,nickname,cash,total,returnPct,online}] }
 *
 * ───────────────────────── 서버 → 클라이언트 (broadcast) ─────────────────────────
 * tick         { ts, prices:{SYM:int}, delist?:{SYM:secLeft} }   매초. 변동된 종목 가격만.
 * stocks       [ {symbol,name,price,basePrice,initialPrice,volatility,drift,halted,delisted,delistIn} ]
 *              종목 메타 변경 시(추가/정지/상폐/파라미터)만 전체 전송.
 * game         { status:'lobby'|'running'|'paused'|'ended', endsAt, remainingMs, settings, tickSec, candleSec }
 * news         { id, text, ts, kind:'info'|'alert' }
 * news:clear   {}                                       관리자가 뉴스 전체 삭제 시
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
  ADMIN_STOCK_HALT: 'admin:stock:halt',
  ADMIN_STOCK_JUMP: 'admin:stock:jump',
  ADMIN_SURGE: 'admin:stock:surge',
  ADMIN_MARKET: 'admin:market',
  ADMIN_DELIST: 'admin:delist',
  ADMIN_NEWS: 'admin:news',
  ADMIN_NEWS_CLEAR: 'admin:news:clear',
  ADMIN_KICK: 'admin:kick',
  ADMIN_STATE: 'admin:state',
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

/** 급등/급락 강도 → 초당 드리프트. 서버가 틱 간격(TICK_SEC)에 맞게 μ·dt로 스케일해서 적용 */
export const STRENGTH_DRIFT = { weak: 0.002, mid: 0.005, strong: 0.012 };
