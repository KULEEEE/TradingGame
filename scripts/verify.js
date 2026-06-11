/**
 * E2E 검증: 참가 → 매수/매도 → 가격 변동 → 리더보드 → 게임 종료 흐름.
 * 사용법: 서버 기동 후 `npm run verify`
 */
import { io as connect } from 'socket.io-client';

const URL = process.env.VERIFY_URL || 'http://localhost:3000';
const PW = process.env.ADMIN_PASSWORD || 'admin1234';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const emit = (sock, ev, payload) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 8000);
  sock.emit(ev, payload, (r) => { clearTimeout(t); res(r); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sock = () => new Promise((res, rej) => {
  const s = connect(URL, { transports: ['websocket'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});

// ── HTTP 페이지 체크 ──
console.log('\n[1] HTTP 페이지');
for (const p of ['/', '/screen', '/admin', '/vendor/lightweight-charts.js', '/shared/events.js', '/healthz']) {
  const r = await fetch(URL + p);
  check(`GET ${p} → ${r.status}`, r.status === 200);
}

// ── 관리자 ──
console.log('\n[2] 관리자 인증');
const admin = await sock();
check('잘못된 비밀번호 거부', !(await emit(admin, 'admin:login', { password: 'wrong' })).ok);
check('인증 전 admin:game 거부', !(await emit(admin, 'admin:game', { action: 'start' })).ok);
check('올바른 비밀번호 통과', (await emit(admin, 'admin:login', { password: PW })).ok);
await emit(admin, 'admin:game', { action: 'reset' }); // 깨끗한 상태에서 시작
await emit(admin, 'admin:settings', { initialCash: 10_000_000, durationMin: 20, feeRate: 0 });

// ── 참가 ──
console.log('\n[3] 참가 / 닉네임');
const p1 = await sock();
const j1 = await emit(p1, 'join', { nickname: '검증봇1' });
check('참가 성공 + 토큰 발급', j1.ok && !!j1.token);
check('초기자금 지급', j1.player?.cash === 10_000_000, `cash=${j1.player?.cash}`);
const p2 = await sock();
check('닉네임 중복 거부', !(await emit(p2, 'join', { nickname: '검증봇1' })).ok);
const j2 = await emit(p2, 'join', { nickname: '검증봇2' });
check('두 번째 참가자 참가', j2.ok);

// ── 게임 시작 전 거래 차단 ──
console.log('\n[4] 거래 검증 (시작 전)');
const sync = await emit(p1, 'sync');
const SYM = sync.stocks[0].symbol;
const tickSec = sync.game.tickSec || 10;
console.log(`  (서버 틱 간격: ${tickSec}초, 캔들: ${sync.game.candleSec}초봉)`);
check('sync에 종목 8개', sync.stocks.length === 8, `len=${sync.stocks.length}`);
check('시작 전 매수 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'buy', qty: 1 })).ok);

// ── 시작 + 매매 ──
console.log('\n[5] 게임 시작 + 매매');
let gotFinal = null, gotLeaderboard = null, tickCount = 0;
p1.on('tick', () => tickCount++);
p1.on('leaderboard', (lb) => gotLeaderboard = lb);
p1.on('final', (f) => gotFinal = f);
let meState = null;
p1.on('me', (m) => meState = m);

check('게임 시작', (await emit(admin, 'admin:game', { action: 'start' })).ok);
const t1 = await emit(p1, 'trade', { symbol: SYM, side: 'buy', qty: 10 });
check('매수 체결', t1.ok, t1.error);
await sleep(300);
check('매수 후 잔고 정확히 차감', meState && meState.cash === 10_000_000 - t1.trade.price * 10,
  `cash=${meState?.cash}, expected=${10_000_000 - (t1.trade?.price ?? 0) * 10}`);
check('보유수량 10주', meState?.holdings?.[0]?.qty === 10);

check('잔고 초과 매수 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'buy', qty: 99_999_999 })).ok);
check('보유 초과 매도 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'sell', qty: 1000 })).ok);
const t2 = await emit(p1, 'trade', { symbol: SYM, side: 'sell', qty: 4 });
check('일부 매도 체결', t2.ok, t2.error);
await sleep(300);
check('매도 후 보유 6주', meState?.holdings?.[0]?.qty === 6, `qty=${meState?.holdings?.[0]?.qty}`);
check('음수 수량 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'buy', qty: -5 })).ok);

// ── 가격 틱 / 차트 / 리더보드 ──
const watchMs = tickSec * 2500 + 500; // 틱 2.5개 분량 관찰
console.log(`\n[6] 틱 / 차트 / 리더보드 (${Math.round(watchMs / 1000)}초 관찰)`);
tickCount = 0;
await sleep(watchMs);
check(`${tickSec}초 틱 브로드캐스트 수신 (2회 이상)`, tickCount >= 2, `ticks=${tickCount}`);
const ch = await emit(p1, 'chart:history', { symbol: SYM });
check('캔들 히스토리 수신 (OHLC)', ch.ok && ch.candles.length >= 1 && 'open' in ch.candles[0] && 'close' in ch.candles[0]);
check('리더보드 수신 + 참가자 포함', !!gotLeaderboard && gotLeaderboard.top.some(r => r.nickname === '검증봇1'),
  JSON.stringify(gotLeaderboard?.top?.map(r => r.nickname)));

// ── 이벤트 ──
console.log('\n[7] 관리자 이벤트');
check('급등 발동', (await emit(admin, 'admin:stock:surge', { symbol: SYM, direction: 1, strength: 'strong', durationSec: 15 })).ok);
check('시장 폭락 발동', (await emit(admin, 'admin:market', { direction: -1, strength: 'mid', durationSec: 15 })).ok);
check('뉴스+효과 발동', (await emit(admin, 'admin:news', { text: '검증 뉴스', effect: { symbol: SYM, direction: 1, strength: 'weak', durationSec: 10 } })).ok);
let gotNewsClear = false;
p1.on('news:clear', () => gotNewsClear = true);
check('뉴스 전체 삭제', (await emit(admin, 'admin:news:clear')).ok);
await sleep(300);
const syncAfterClear = await emit(p1, 'sync');
check('삭제 후 뉴스 목록 비움 + 전체 브로드캐스트', gotNewsClear && syncAfterClear.news.length === 0,
  `clear=${gotNewsClear}, news=${syncAfterClear.news.length}`);
const sync2 = await emit(p1, 'sync');
const SYM2 = sync2.stocks[1].symbol;
check('거래정지 발동', (await emit(admin, 'admin:stock:halt', { symbol: SYM2, halted: true })).ok);
check('거래정지 종목 매수 거부', !(await emit(p1, 'trade', { symbol: SYM2, side: 'buy', qty: 1 })).ok);
check('거래정지 해제', (await emit(admin, 'admin:stock:halt', { symbol: SYM2, halted: false })).ok);
const SYM3 = sync2.stocks[7].symbol;
check('즉시 상폐 발동', (await emit(admin, 'admin:delist', { symbol: SYM3, immediate: true })).ok);
check('상폐 종목 매수 거부', !(await emit(p1, 'trade', { symbol: SYM3, side: 'buy', qty: 1 })).ok);
const sync3 = await emit(p1, 'sync');
check('상폐 종목 가격 0 + 딱지 유지', sync3.stocks.find(s => s.symbol === SYM3)?.delisted === true && sync3.stocks.find(s => s.symbol === SYM3)?.price === 0);

// ── 서킷브레이커 ──
console.log('\n[8] 서킷브레이커');
check('일시정지', (await emit(admin, 'admin:game', { action: 'pause' })).ok);
check('일시정지 중 거래 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'buy', qty: 1 })).ok);
tickCount = 0;
await sleep(tickSec * 1500 + 500); // 틱 1.5개 분량 대기
check('일시정지 중 틱 동결', tickCount === 0, `ticks=${tickCount}`);
check('재개', (await emit(admin, 'admin:game', { action: 'resume' })).ok);

// ── 재접속 복구 ──
console.log('\n[9] 재접속 복구');
const p1b = await sock();
const rs = await emit(p1b, 'resume', { token: j1.token });
check('토큰으로 계정 복구', rs.ok && rs.player.nickname === '검증봇1' && rs.player.holdings[0]?.qty === 6);
check('없는 토큰 거부', !(await emit(p1b, 'resume', { token: 'fake' })).ok);

// ── 종료 ──
console.log('\n[10] 게임 종료');
check('종료 실행', (await emit(admin, 'admin:game', { action: 'end' })).ok);
await sleep(500);
check('final 랭킹 브로드캐스트', !!gotFinal && gotFinal.rankings.length === 2 && gotFinal.rankings[0].rank === 1);
check('종료 후 거래 거부', !(await emit(p1, 'trade', { symbol: SYM, side: 'sell', qty: 1 })).ok);

// ── 리셋 ──
console.log('\n[11] 리셋');
check('리셋 실행', (await emit(admin, 'admin:game', { action: 'reset' })).ok);
const rs2 = await emit(p1b, 'resume', { token: j1.token });
check('리셋 후 잔고/보유 초기화 + 계정 유지', rs2.ok && rs2.player.cash === 10_000_000 && rs2.player.holdings.length === 0);

console.log(`\n━━━ 결과: ${passed} 통과 / ${failed} 실패 ━━━`);
for (const s of [p1, p2, p1b, admin]) s.close();
process.exit(failed > 0 ? 1 : 0);
