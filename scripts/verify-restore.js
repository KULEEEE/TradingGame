/**
 * 스냅샷 복구 검증.
 *   1단계: node scripts/verify-restore.js join   → 참가 후 7초 대기(스냅샷 저장), 토큰 출력
 *   (서버 재시작)
 *   2단계: node scripts/verify-restore.js resume <token> → 토큰으로 복구 확인
 */
import { io as connect } from 'socket.io-client';

const URL = process.env.VERIFY_URL || 'http://localhost:3000';
const [mode, token] = process.argv.slice(2);
const s = connect(URL, { transports: ['websocket'] });
const emit = (ev, p) => new Promise(r => s.emit(ev, p, r));
await new Promise(r => s.on('connect', r));

if (mode === 'join') {
  const j = await emit('join', { nickname: '복구테스트' });
  if (!j.ok) { console.error('join 실패:', j.error); process.exit(1); }
  console.log('TOKEN=' + j.token);
  await new Promise(r => setTimeout(r, 7000)); // 5초 스냅샷 주기 대기
  process.exit(0);
} else if (mode === 'resume') {
  const r = await emit('resume', { token });
  if (r.ok && r.player.nickname === '복구테스트') {
    console.log('✅ 서버 재시작 후 토큰 복구 성공 (nickname=' + r.player.nickname + ', cash=' + r.player.cash + ')');
    process.exit(0);
  }
  console.error('❌ 복구 실패:', JSON.stringify(r));
  process.exit(1);
}
