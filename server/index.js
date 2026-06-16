import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { EV } from '../shared/events.js';
import { Game } from './game.js';
import { loadSnapshot, startSnapshotLoop, deleteSnapshot } from './persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ───────────────────────── HTTP ─────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 25000,
});

app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/vendor/lightweight-charts.js', (_req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));
app.get('/screen', (_req, res) => res.sendFile(path.join(ROOT, 'public/screen.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public/admin.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ───────────────────────── 게임 초기화 ─────────────────────────

const stockDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/stocks.json'), 'utf8'));
const game = new Game(io, stockDefs);

const snap = loadSnapshot(ROOT);
if (snap && Array.isArray(snap.players) && snap.players.length > 0) {
  if (game.restore(snap)) {
    console.log(`[복구] state.json에서 참가자 ${snap.players.length}명 상태 복구 (${new Date(snap.savedAt).toLocaleTimeString('ko-KR')} 저장분)`);
    if (game.status === 'paused') console.log('[복구] 진행 중이던 게임은 "일시정지" 상태로 복구됨 → 관리자 화면에서 [재개]를 누르세요');
  }
}
startSnapshotLoop(ROOT, game);

// ───────────────────────── 접속 URL / QR ─────────────────────────

function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
  return all.find(a => a.startsWith('192.168.')) || all.find(a => a.startsWith('10.')) || all[0] || 'localhost';
}

let tunnelUrl = null; // --tunnel 모드에서 cloudflared가 발급한 외부 URL

function joinUrl() {
  const pub = process.env.PUBLIC_URL;
  if (pub) return pub.replace(/\/+$/, '');
  if (tunnelUrl) return tunnelUrl;
  return `http://${lanIp()}:${PORT}`;
}

// ── Cloudflare Quick Tunnel (외부망 접속, 계정 불필요) ──
// 실행: npm run dev:tunnel  (또는 node server/index.js --tunnel, TUNNEL=1)
const WANT_TUNNEL = process.argv.includes('--tunnel')
  || ['1', 'true'].includes(String(process.env.TUNNEL).toLowerCase());

function startTunnel() {
  if (process.env.PUBLIC_URL) {
    console.log('[tunnel] PUBLIC_URL이 설정되어 있어 터널을 시작하지 않습니다');
    return;
  }
  console.log('[tunnel] cloudflared 터널 연결 중…');
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  let found = false;
  const onData = async (buf) => {
    if (found) return;
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    found = true;
    tunnelUrl = m[0];
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  🌐 외부망 접속 주소(QR 자동 갱신됨): ${tunnelUrl}`);
    console.log(`     메인 스크린: ${tunnelUrl}/screen   관리자: ${tunnelUrl}/admin`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    try { io.emit(EV.JOIN_URL, { joinUrl: joinUrl(), qrDataUrl: await qrDataUrl() }); } catch { /* QR 실패해도 무시 */ }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => {
    console.error('[tunnel] cloudflared를 찾을 수 없습니다. 설치 후 다시 실행하세요:');
    console.error('         winget install Cloudflare.cloudflared   (macOS: brew install cloudflared)');
    console.error('         설치 없이는 LAN IP 주소로만 접속 가능합니다.');
  });
  child.on('exit', (code) => {
    if (tunnelUrl) console.error(`[tunnel] 터널이 끊어졌습니다 (code ${code}) — LAN IP로 폴백`);
    tunnelUrl = null;
  });
  process.on('exit', () => { try { child.kill(); } catch { /* 이미 종료 */ } });
}

let qrCache = { url: null, dataUrl: null };
async function qrDataUrl() {
  const url = joinUrl();
  if (qrCache.url !== url) {
    qrCache = { url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 400, color: { dark: '#000000', light: '#ffffff' } }) };
  }
  return qrCache.dataUrl;
}

// ───────────────────────── Socket.IO ─────────────────────────

io.on('connection', (socket) => {
  const ack = (cb, data) => { if (typeof cb === 'function') cb(data); };

  socket.on(EV.SYNC, (_p, cb) => ack(cb, { ...game.syncPayload(), joinUrl: joinUrl() }));

  socket.on(EV.SCREEN_HELLO, async (_p, cb) => {
    try { ack(cb, { qrDataUrl: await qrDataUrl(), joinUrl: joinUrl() }); }
    catch (e) { ack(cb, { qrDataUrl: null, joinUrl: joinUrl() }); }
  });

  socket.on(EV.JOIN, (p, cb) => {
    const r = game.join(p?.nickname, p?.password);
    if (r.ok) {
      socket.data.token = r.token;
      socket.join('p:' + r.token);
    }
    ack(cb, r);
  });

  socket.on(EV.RESUME, (p, cb) => {
    const player = game.players.get(p?.token);
    if (!player) return ack(cb, { ok: false, error: '계정을 찾을 수 없습니다' });
    socket.data.token = player.token;
    socket.join('p:' + player.token);
    ack(cb, { ok: true, player: game.playerState(player) });
  });

  socket.on(EV.TRADE, (p, cb) => {
    if (!socket.data.token) return ack(cb, { ok: false, error: '먼저 참가해주세요' });
    ack(cb, game.trade(socket.data.token, p?.symbol, p?.side, p?.qty));
  });

  socket.on(EV.CHART, (p, cb) => ack(cb, game.chartHistory(p?.symbol)));

  // ── 관리자 ──
  socket.on(EV.ADMIN_LOGIN, (p, cb) => {
    if (p?.password === ADMIN_PASSWORD) {
      socket.data.isAdmin = true;
      ack(cb, { ok: true });
    } else {
      ack(cb, { ok: false, error: '비밀번호가 틀렸습니다' });
    }
  });

  const admin = (handler) => (p, cb) => {
    if (!socket.data.isAdmin) return ack(cb, { ok: false, error: '관리자 인증이 필요합니다' });
    try { ack(cb, handler(p || {})); }
    catch (e) { console.error('[admin]', e); ack(cb, { ok: false, error: e.message }); }
  };

  socket.on(EV.ADMIN_GAME, admin(p => {
    const r = game.gameAction(p.action);
    if (p.action === 'reset' && r.ok) deleteSnapshot(ROOT);
    return r;
  }));
  socket.on(EV.ADMIN_SETTINGS, admin(p => game.updateSettings(p)));
  socket.on(EV.ADMIN_STOCK_ADD, admin(p => {
    const r = game.addStock(p);
    if (r.ok) game.addNews(`✨ 신규 상장: ${p.name}(${String(p.symbol).toUpperCase()})`, 'alert');
    return r;
  }));
  socket.on(EV.ADMIN_STOCK_UPDATE, admin(p => game.updateStock(p.symbol, p)));
  socket.on(EV.ADMIN_STOCK_REMOVE, admin(p => game.removeStock(p.symbol)));
  socket.on(EV.ADMIN_STOCK_HALT, admin(p => game.haltStock(p.symbol, p.halted)));
  socket.on(EV.ADMIN_STOCK_JUMP, admin(p => game.jumpStock(p.symbol, p.pct)));
  socket.on(EV.ADMIN_SURGE, admin(p => game.surgeStock(p.symbol, p.direction, p.strength, p.durationSec)));
  socket.on(EV.ADMIN_MARKET, admin(p => game.marketEvent(p.direction, p.strength, p.durationSec)));
  socket.on(EV.ADMIN_DELIST, admin(p => game.delistStock(p.symbol, p.immediate)));
  socket.on(EV.ADMIN_NEWS, admin(p => game.adminNews(p.text, p.effect)));
  socket.on(EV.ADMIN_NEWS_CLEAR, admin(() => game.clearNews()));
  socket.on(EV.ADMIN_KICK, admin(p => game.kick(p.token)));
  socket.on(EV.ADMIN_STATE, admin(() => game.adminState()));
  socket.on(EV.ADMIN_SCENARIO, admin(p => game.setScenario(p.symbol, p.trend, p.vol)));
  socket.on(EV.ADMIN_NEXT_DAY, admin(() => game.nextDay()));
});

// ───────────────────────── 기동 ─────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const url = joinUrl();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 워크샵 모의 주식 트레이딩 게임 서버 기동');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  참가자 (QR 인코딩 대상):  ${url}`);
  console.log(`  메인 스크린:              ${url}/screen`);
  console.log(`  관리자:                   ${url}/admin  (비밀번호: ${process.env.ADMIN_PASSWORD ? '환경변수 설정값' : `기본값 ${ADMIN_PASSWORD}`})`);
  if (!process.env.PUBLIC_URL) {
    console.log(`  * PUBLIC_URL 미설정 → LAN IP(${lanIp()}) 자동 감지 사용`);
    console.log('  * 클라우드 배포 시 PUBLIC_URL=https://도메인 설정 필수');
    if (!WANT_TUNNEL) console.log('  * 외부망(모바일 데이터) 접속이 필요하면: npm run dev:tunnel');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (WANT_TUNNEL) startTunnel();
});
