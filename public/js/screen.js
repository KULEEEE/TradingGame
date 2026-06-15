import { EV } from '/shared/events.js';
import {
  fmtWon, fmtNum, fmtPct, pctClass, changePct, fmtTime, STATUS_LABEL,
  createCandleChart, setCandles, makeCandleFeed, drawSpark, emitAck, CHART_COLORS,
} from '/js/common.js';

const $ = (id) => document.getElementById(id);
const socket = io();

let game = { status: 'lobby', remainingMs: 0, endsAt: null };
let stocks = [];                 // 메타 (stocks 이벤트)
const prices = new Map();        // symbol -> 최신가
const sparks = new Map();        // symbol -> 가격 포인트 배열
const delistLeft = new Map();    // symbol -> 남은 초
let newsItems = [];
let chartOpen = null;            // { symbol, chart, series, feed }

// ───────── 초기 동기화 ─────────
socket.on('connect', async () => {
  const s = await emitAck(socket, EV.SYNC);
  game = s.game;
  stocks = s.stocks;
  for (const st of stocks) prices.set(st.symbol, st.price);
  for (const [sym, arr] of Object.entries(s.sparks || {})) sparks.set(sym, arr.slice());
  newsItems = s.news || [];
  renderTicker();
  renderGrid();
  renderLeaderboard(s.leaderboard);
  renderGame();
  const hello = await emitAck(socket, EV.SCREEN_HELLO);
  if (hello.qrDataUrl) $('qrImg').src = hello.qrDataUrl;
  $('joinUrl').textContent = (hello.joinUrl || '').replace(/^https?:\/\//, '');
});

// ───────── 실시간 이벤트 ─────────
socket.on(EV.TICK, ({ ts, prices: p, delist }) => {
  delistLeft.clear();
  if (delist) for (const [sym, sec] of Object.entries(delist)) delistLeft.set(sym, sec);
  for (const [sym, price] of Object.entries(p)) {
    prices.set(sym, price);
    const arr = sparks.get(sym) || [];
    arr.push(price);
    if (arr.length > 90) arr.shift();
    sparks.set(sym, arr);
    if (chartOpen && chartOpen.symbol === sym) {
      chartOpen.feed(ts, price);
      $('chartPrice').textContent = fmtWon(price);
    }
  }
  updateGridPrices();
  renderDelistBanner();
});

socket.on(EV.STOCKS, (list) => {
  stocks = list;
  for (const st of stocks) prices.set(st.symbol, st.price);
  renderGrid();
});

socket.on(EV.GAME, (g) => { game = g; renderGame(); });

socket.on(EV.NEWS, (item) => {
  newsItems.push(item);
  renderTicker();
});

socket.on(EV.NEWS_CLEAR, () => {
  newsItems = [];
  renderTicker();
});

socket.on(EV.JOIN_URL, ({ joinUrl, qrDataUrl }) => {
  if (qrDataUrl) $('qrImg').src = qrDataUrl;
  $('joinUrl').textContent = (joinUrl || '').replace(/^https?:\/\//, '');
});

// 오래된 뉴스는 티커에서 자동 제거 (쌓임 방지)
const NEWS_TTL_MS = 120_000;
setInterval(() => {
  const before = newsItems.length;
  newsItems = newsItems.filter(n => Date.now() - n.ts < NEWS_TTL_MS);
  if (newsItems.length !== before) renderTicker();
}, 5000);

socket.on(EV.LEADERBOARD, renderLeaderboard);

socket.on(EV.FINAL, ({ rankings }) => renderFinal(rankings));

// ───────── 렌더링 ─────────
function renderGrid() {
  const grid = $('stockGrid');
  grid.innerHTML = '';
  for (const st of stocks) {
    const card = document.createElement('div');
    card.className = 'stock-card' + (st.delisted ? ' delisted' : '');
    card.dataset.sym = st.symbol;
    card.innerHTML = `
      <div class="badges"></div>
      <div class="name">${st.name} <span class="sym">${st.symbol}</span></div>
      <div class="price"></div>
      <div class="chg"></div>
      <canvas width="130" height="42"></canvas>`;
    card.addEventListener('click', () => toggleChart(st.symbol));
    grid.appendChild(card);
  }
  updateGridPrices();
}

function updateGridPrices() {
  for (const card of document.querySelectorAll('.stock-card')) {
    const sym = card.dataset.sym;
    const st = stocks.find(s => s.symbol === sym);
    if (!st) continue;
    const price = prices.get(sym) ?? st.price;
    const chg = changePct(price, st.basePrice);
    const cls = pctClass(chg);
    card.querySelector('.price').textContent = st.delisted ? '─' : fmtWon(price);
    card.querySelector('.price').className = 'price ' + cls;
    const chgEl = card.querySelector('.chg');
    chgEl.textContent = st.delisted ? '상장폐지' : `${chg >= 0 ? '▲' : '▼'} ${fmtPct(chg)}`;
    chgEl.className = 'chg ' + (st.delisted ? 'muted' : cls);
    // 배지
    const badges = [];
    if (st.delisted) badges.push('<span class="badge delist">상장폐지</span>');
    else if (delistLeft.has(sym)) badges.push(`<span class="badge warning">상폐 ${delistLeft.get(sym)}초 전</span>`);
    else if (st.halted) badges.push('<span class="badge halt">거래정지</span>');
    card.querySelector('.badges').innerHTML = badges.join('');
    drawSpark(card.querySelector('canvas'), sparks.get(sym), cls === 'up' ? CHART_COLORS.up : cls === 'down' ? CHART_COLORS.down : CHART_COLORS.text);
  }
}

function renderLeaderboard(lb) {
  if (!lb) return;
  $('playerCount').textContent = `(${lb.totalPlayers}명 참가)`;
  $('leaderboard').innerHTML = lb.top.map(r => `
    <li>
      <span class="rank">${r.rank}</span>
      <span class="nick">${esc(r.nickname)}</span>
      <span class="total">${fmtWon(r.total)}</span>
      <span class="ret ${pctClass(r.returnPct)}">${fmtPct(r.returnPct)}</span>
    </li>`).join('') || '<li class="muted" style="justify-content:center">QR을 스캔해 참가하세요!</li>';
}

function renderTicker() {
  const items = newsItems.slice(-5).reverse(); // 최신 5건만, 2분 지나면 자동 제거
  $('tickerInner').textContent = items.length
    ? items.map(n => n.text).join('     ◆     ')
    : '시장 뉴스가 여기에 표시됩니다…';
}

function renderGame() {
  const pill = $('gameStatus');
  pill.textContent = STATUS_LABEL[game.status] || game.status;
  pill.className = 'status-pill ' + game.status;
  // 거래일 표시
  const total = game.totalDays ?? game.settings?.totalDays ?? 1;
  $('dayInfo').textContent = game.currentDay ? `${game.currentDay}일차 / ${total}일` : (total > 1 ? `총 ${total} 거래일` : '');
  $('pausedOverlay').classList.toggle('hidden', game.status !== 'paused');
  $('intermissionOverlay').classList.toggle('hidden', game.status !== 'intermission');
  if (game.status === 'intermission') $('interDay').textContent = `(${game.currentDay}일차)`;
  if (game.status !== 'ended') $('finalOverlay').classList.add('hidden');
}

function renderDelistBanner() {
  const banner = $('delistBanner');
  if (delistLeft.size === 0) return banner.classList.add('hidden');
  const parts = [...delistLeft.entries()].map(([sym, sec]) => {
    const st = stocks.find(s => s.symbol === sym);
    return `🚨 ${st?.name || sym} 상장폐지 ${sec}초 전 — 지금 탈출하세요!`;
  });
  banner.textContent = parts.join('   ');
  banner.classList.remove('hidden');
}

function renderFinal(rankings) {
  const medals = ['🥇', '🥈', '🥉'];
  const top3 = rankings.slice(0, 3);
  // 2등 - 1등 - 3등 순으로 배치 (시상대 모양)
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  $('podium').innerHTML = order.map(r => `
    <div class="spot p${r.rank}">
      <div class="medal">${medals[r.rank - 1]}</div>
      <div class="nick">${esc(r.nickname)}</div>
      <div class="total">${fmtWon(r.total)}</div>
      <div class="ret ${pctClass(r.returnPct)}">${fmtPct(r.returnPct)}</div>
    </div>`).join('');
  $('finalRest').innerHTML = rankings.slice(3, 11).map(r => `
    <li><span class="rank muted">${r.rank}위</span><span class="nick">${esc(r.nickname)}</span>
        <span>${fmtWon(r.total)}</span><span class="${pctClass(r.returnPct)}">${fmtPct(r.returnPct)}</span></li>`).join('');
  $('finalOverlay').classList.remove('hidden');
}

// ───────── 대형 차트 ─────────
async function toggleChart(symbol) {
  if (chartOpen) { closeChart(); return; }
  const st = stocks.find(s => s.symbol === symbol);
  if (!st) return;
  const res = await emitAck(socket, EV.CHART, { symbol });
  if (!res.ok) return;
  $('chartTitle').textContent = `${st.name} (${st.symbol})`;
  $('chartPrice').textContent = fmtWon(res.price);
  $('chartModal').classList.remove('hidden');
  const { chart, series } = createCandleChart($('bigChart'));
  setCandles(series, res.candles);
  chart.timeScale().fitContent();
  chartOpen = { symbol, chart, series, feed: makeCandleFeed(series, res.candles.at(-1), game.candleSec) };
}

function closeChart() {
  if (!chartOpen) return;
  chartOpen.chart.remove();
  chartOpen = null;
  $('chartModal').classList.add('hidden');
  $('bigChart').innerHTML = '';
}
$('chartModal').addEventListener('click', closeChart);

// ───────── 타이머 ─────────
setInterval(() => {
  let ms;
  if (game.status === 'running') ms = Math.max(0, game.endsAt - Date.now());
  else ms = game.remainingMs;
  const t = $('timer');
  t.textContent = game.status === 'ended' ? '00:00' : fmtTime(ms);
  t.classList.toggle('urgent', game.status === 'running' && ms < 60_000);
}, 250);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
