import { EV } from '/shared/events.js';
import { fmtWon, fmtPct, pctClass, changePct, fmtTime, STATUS_LABEL, emitAck } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const socket = io();

const PW_KEY = 'tg_admin_pw';
let game = { status: 'lobby', remainingMs: 0, endsAt: null, settings: {} };
let stocks = [];
const prices = new Map();
let loggedIn = false;
let settingsLoaded = false;

// ───────── 로그인 ─────────
socket.on('connect', async () => {
  loggedIn = false;
  const saved = sessionStorage.getItem(PW_KEY);
  if (saved && (await tryLogin(saved))) return;
  $('loginView').classList.remove('hidden');
  $('adminView').classList.add('hidden');
});

$('loginBtn').addEventListener('click', login);
$('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
async function login() {
  const pw = $('pwInput').value;
  if (!(await tryLogin(pw))) $('loginErr').textContent = '비밀번호가 틀렸습니다';
}

async function tryLogin(pw) {
  const r = await emitAck(socket, EV.ADMIN_LOGIN, { password: pw });
  if (!r.ok) return false;
  sessionStorage.setItem(PW_KEY, pw);
  loggedIn = true;
  $('loginView').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  const s = await emitAck(socket, EV.SYNC);
  game = s.game;
  stocks = s.stocks;
  for (const st of stocks) prices.set(st.symbol, st.price);
  settingsLoaded = false;
  renderGame();
  renderStockTable();
  refreshPlayers();
  return true;
}

// ───────── 실시간 ─────────
socket.on(EV.TICK, ({ prices: p }) => {
  for (const [sym, price] of Object.entries(p)) prices.set(sym, price);
  updateStockPrices();
});
socket.on(EV.STOCKS, (list) => {
  stocks = list;
  for (const st of stocks) prices.set(st.symbol, st.price);
  renderStockTable();
});
socket.on(EV.GAME, (g) => { game = g; renderGame(); });
socket.on(EV.NEWS, (n) => toast(n.text));

setInterval(() => {
  const ms = game.status === 'running' ? Math.max(0, game.endsAt - Date.now()) : game.remainingMs;
  $('timer').textContent = fmtTime(ms);
}, 500);
setInterval(() => { if (loggedIn) refreshPlayers(); }, 3000);

// ───────── 게임 제어 ─────────
function renderGame() {
  const pill = $('gameStatus');
  pill.textContent = STATUS_LABEL[game.status];
  pill.className = 'status-pill ' + game.status;
  if (!settingsLoaded && game.settings) {
    $('setCash').value = game.settings.initialCash;
    $('setDuration').value = game.settings.durationMin;
    $('setFee').value = (game.settings.feeRate * 100).toFixed(2);
    settingsLoaded = true;
  }
}

async function gameAction(action, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  const r = await emitAck(socket, EV.ADMIN_GAME, { action });
  if (!r.ok) toast(r.error, 'err');
}
$('btnStart').addEventListener('click', () => gameAction('start'));
$('btnPause').addEventListener('click', () => gameAction('pause'));
$('btnResume').addEventListener('click', () => gameAction('resume'));
$('btnEnd').addEventListener('click', () => gameAction('end', '게임을 종료하고 최종 순위를 발표할까요?'));
$('btnReset').addEventListener('click', () => gameAction('reset', '모든 참가자의 잔고/보유/거래내역과 가격이 초기화됩니다. 리셋할까요?'));

$('btnSettings').addEventListener('click', async () => {
  const r = await emitAck(socket, EV.ADMIN_SETTINGS, {
    initialCash: Number($('setCash').value),
    durationMin: Number($('setDuration').value),
    feeRate: Number($('setFee').value) / 100,
  });
  toast(r.ok ? '설정이 적용되었습니다' : r.error, r.ok ? 'ok' : 'err');
});

// ───────── 시장 이벤트 / 뉴스 ─────────
const evParams = () => ({ strength: $('evStrength').value, durationSec: Number($('evDuration').value) });

$('btnBoom').addEventListener('click', async () => {
  await emitAck(socket, EV.ADMIN_MARKET, { direction: 1, ...evParams() });
});
$('btnCrash').addEventListener('click', async () => {
  await emitAck(socket, EV.ADMIN_MARKET, { direction: -1, ...evParams() });
});

$('btnNews').addEventListener('click', async () => {
  const text = $('newsText').value.trim();
  if (!text) return toast('뉴스 내용을 입력하세요', 'err');
  const symbol = $('newsSymbol').value;
  const payload = { text };
  if (symbol) payload.effect = { symbol, direction: Number($('newsDirection').value), ...evParams() };
  const r = await emitAck(socket, EV.ADMIN_NEWS, payload);
  if (r.ok) { $('newsText').value = ''; toast('뉴스 발송 완료', 'ok'); }
  else toast(r.error, 'err');
});

$('btnNewsClear').addEventListener('click', async () => {
  const r = await emitAck(socket, EV.ADMIN_NEWS_CLEAR);
  toast(r.ok ? '모든 화면의 뉴스를 비웠습니다' : r.error, r.ok ? 'ok' : 'err');
});

// ───────── 종목 테이블 ─────────
function renderStockTable() {
  const tbody = document.querySelector('#stockTable tbody');
  tbody.innerHTML = '';
  // 뉴스 효과용 종목 셀렉트도 함께 갱신
  $('newsSymbol').innerHTML = '<option value="">가격효과 없음</option>' +
    stocks.filter(s => !s.delisted).map(s => `<option value="${s.symbol}">${esc(s.name)}</option>`).join('');

  for (const st of stocks) {
    const tr = document.createElement('tr');
    tr.dataset.sym = st.symbol;
    if (st.delisted) {
      tr.innerHTML = `
        <td><span class="cell-name">${esc(st.name)}</span> <span class="cell-sym">${st.symbol}</span></td>
        <td colspan="8"><span class="badge delist">상장폐지</span></td><td></td>`;
      tbody.appendChild(tr);
      continue;
    }
    tr.innerHTML = `
      <td><span class="cell-name">${esc(st.name)}</span> <span class="cell-sym">${st.symbol}</span>
          ${st.halted ? '<span class="badge halt">정지</span>' : ''}
          ${st.delistIn != null ? '<span class="badge warning">상폐중</span>' : ''}</td>
      <td class="c-price"></td>
      <td class="c-chg"></td>
      <td><input class="i-vol" type="number" step="0.001" value="${st.volatility}"></td>
      <td><input class="i-drift" type="number" step="0.0001" value="${st.drift}"></td>
      <td><button class="mini b-apply">적용</button></td>
      <td>
        <button class="mini up-btn b-surge">▲ 급등</button>
        <button class="mini down-btn b-crash">▼ 급락</button>
      </td>
      <td><div class="jump-cell"><input class="i-jump" type="number" value="10">% <button class="mini b-jump">실행</button></div></td>
      <td><button class="mini b-halt">${st.halted ? '재개' : '정지'}</button></td>
      <td>
        <button class="mini danger b-delist">상폐</button>
        <button class="mini danger b-delist-now">즉시</button>
      </td>`;

    const sym = st.symbol;
    tr.querySelector('.b-apply').addEventListener('click', async () => {
      const r = await emitAck(socket, EV.ADMIN_STOCK_UPDATE, {
        symbol: sym,
        volatility: Number(tr.querySelector('.i-vol').value),
        drift: Number(tr.querySelector('.i-drift').value),
      });
      toast(r.ok ? `${sym} 파라미터 적용` : r.error, r.ok ? 'ok' : 'err');
    });
    tr.querySelector('.b-surge').addEventListener('click', () =>
      emitAck(socket, EV.ADMIN_SURGE, { symbol: sym, direction: 1, ...evParams() }).then(() => toast(`${sym} 급등 발동`, 'ok')));
    tr.querySelector('.b-crash').addEventListener('click', () =>
      emitAck(socket, EV.ADMIN_SURGE, { symbol: sym, direction: -1, ...evParams() }).then(() => toast(`${sym} 급락 발동`, 'ok')));
    tr.querySelector('.b-jump').addEventListener('click', async () => {
      const pct = Number(tr.querySelector('.i-jump').value);
      const r = await emitAck(socket, EV.ADMIN_STOCK_JUMP, { symbol: sym, pct });
      toast(r.ok ? `${sym} ${pct > 0 ? '+' : ''}${pct}% 점프` : r.error, r.ok ? 'ok' : 'err');
    });
    tr.querySelector('.b-halt').addEventListener('click', () =>
      emitAck(socket, EV.ADMIN_STOCK_HALT, { symbol: sym, halted: !st.halted }));
    tr.querySelector('.b-delist').addEventListener('click', () => {
      if (confirm(`정말 ${st.name}(${sym})을(를) 상장폐지할까요?\n30초 카운트다운 후 가격이 0이 되고 거래가 영구 잠깁니다.`))
        emitAck(socket, EV.ADMIN_DELIST, { symbol: sym, immediate: false });
    });
    tr.querySelector('.b-delist-now').addEventListener('click', () => {
      if (confirm(`⚠️ ${st.name}(${sym}) 즉시 상장폐지 — 카운트다운 없이 바로 0원 처리됩니다. 진행할까요?`))
        emitAck(socket, EV.ADMIN_DELIST, { symbol: sym, immediate: true });
    });
    tbody.appendChild(tr);
  }
  updateStockPrices();
}

function updateStockPrices() {
  for (const tr of document.querySelectorAll('#stockTable tbody tr')) {
    const st = stocks.find(s => s.symbol === tr.dataset.sym);
    if (!st || st.delisted) continue;
    const price = prices.get(st.symbol) ?? st.price;
    const chg = changePct(price, st.basePrice);
    const priceEl = tr.querySelector('.c-price');
    const chgEl = tr.querySelector('.c-chg');
    if (priceEl) { priceEl.textContent = fmtWon(price); priceEl.className = 'c-price ' + pctClass(chg); }
    if (chgEl) { chgEl.textContent = fmtPct(chg); chgEl.className = 'c-chg ' + pctClass(chg); }
  }
}

$('btnAddStock').addEventListener('click', async () => {
  const r = await emitAck(socket, EV.ADMIN_STOCK_ADD, {
    symbol: $('addSymbol').value,
    name: $('addName').value,
    initialPrice: Number($('addPrice').value),
    volatility: Number($('addVol').value) || 0.02,
    drift: Number($('addDrift').value) || 0.0002,
  });
  if (r.ok) {
    toast('종목이 추가되었습니다', 'ok');
    for (const id of ['addSymbol', 'addName', 'addPrice', 'addVol', 'addDrift']) $(id).value = '';
  } else toast(r.error, 'err');
});

// ───────── 참가자 ─────────
async function refreshPlayers() {
  const r = await emitAck(socket, EV.ADMIN_STATE);
  if (!r || !r.players) return;
  $('playerCount').textContent = `참가자 ${r.players.length}명`;
  const tbody = document.querySelector('#playerTable tbody');
  tbody.innerHTML = r.players.map(p => `
    <tr>
      <td>${p.rank}</td>
      <td><b>${esc(p.nickname)}</b></td>
      <td>${fmtWon(p.total)}</td>
      <td class="${pctClass(p.returnPct)}">${fmtPct(p.returnPct)}</td>
      <td>${p.online ? '🟢' : '⚪'}</td>
      <td><button class="mini danger" data-token="${p.token}">강퇴</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">아직 참가자가 없습니다</td></tr>';
  for (const btn of tbody.querySelectorAll('button[data-token]')) {
    btn.addEventListener('click', () => {
      if (confirm('이 참가자를 강퇴할까요?'))
        emitAck(socket, EV.ADMIN_KICK, { token: btn.dataset.token }).then(refreshPlayers);
    });
  }
}

// ───────── 토스트 ─────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
