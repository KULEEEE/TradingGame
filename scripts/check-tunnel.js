/** 터널 경유 접속 점검: node scripts/check-tunnel.js https://xxx.trycloudflare.com */
import { io as connect } from 'socket.io-client';

const URL = process.argv[2];
if (!URL) { console.error('사용법: node scripts/check-tunnel.js <외부 URL>'); process.exit(1); }

const r = await fetch(URL + '/healthz');
console.log((r.status === 200 ? '✅' : '❌') + ` GET ${URL}/healthz → ${r.status}`);

const s = connect(URL, { transports: ['websocket'] });
const ok = await new Promise((res) => {
  const t = setTimeout(() => res(false), 10000);
  s.on('connect', () => { clearTimeout(t); res(true); });
  s.on('connect_error', (e) => { console.error('  connect_error:', e.message); });
});
console.log((ok ? '✅' : '❌') + ' Socket.IO WebSocket 연결 (터널 경유)');
if (ok) {
  const sync = await new Promise(res => s.emit('sync', null, res));
  const match = sync.joinUrl === URL;
  console.log((match ? '✅' : '❌') + ` QR 인코딩 URL이 터널 주소로 갱신됨 (${sync.joinUrl})`);
  const ticked = await new Promise(res => { const t = setTimeout(() => res(false), 15000); s.once('tick', () => { clearTimeout(t); res(true); }); });
  console.log((ticked ? '✅' : '❌') + ' 가격 틱 브로드캐스트 수신 (터널 경유)');
}
s.close();
process.exit(0);
