import { EV } from '/shared/events.js';
import {
  fmtWon, fmtNum, fmtPct, pctClass, changePct, fmtTime, fmtClock, STATUS_LABEL,
  createCandleChart, setCandles, makeCandleFeed, emitAck,
} from '/js/common.js';

const $ = (id) => document.getElementById(id);
const socket = io();

const TOKEN_KEY = 'tg_token';
let token = localStorage.getItem(TOKEN_KEY);
let me = null;                 // 서버의 me 페이로드
let stocks = [];               // 종목 메타
const prices = new Map();      // symbol -> 최신가
const delistLeft = new Map();
let game = { status: 'lobby', remainingMs: 0, endsAt: null, settings: { feeRate: 0 } };
let newsItems = [];            // 뉴스 탭 이력 (최신순)
const MAX_NEWS_ITEMS = 50;
let detail = null;             // { symbol, chart, series, feed }
let side = 'buy';

// ───────── 접속 / 복구 ─────────
socket.on('connect', async () => {
  const s = await emitAck(socket, EV.SYNC);
  applySync(s);
  if (token) {
    const r = await emitAck(socket, EV.RESUME, { token });
    if (r.ok) { me = r.player; showApp(); }
    else { localStorage.removeItem(TOKEN_KEY); token = null; showJoin(); }
  } else {
    showJoin();
  }
});

function applySync(s) {
  game = s.game;
  stocks = s.stocks;
  for (const st of stocks) prices.set(st.symbol, st.price);
  newsItems = [...(s.newsHistory || s.news || [])].reverse(); // 서버는 과거→최신, 탭은 최신순
  renderGameBadge();
  renderMarket();
  renderNews();
}

function showJoin() {
  $('joinView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}

function showApp() {
  $('joinView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  renderAll();
}

$('joinBtn').addEventListener('click', join);
$('nickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
async function join() {
  const nickname = $('nickInput').value.trim();
  if (!nickname) return ($('joinErr').textContent = '닉네임을 입력하세요');
  const r = await emitAck(socket, EV.JOIN, { nickname });
  if (!r.ok) return ($('joinErr').textContent = r.error);
  token = r.token;
  localStorage.setItem(TOKEN_KEY, token);
  me = r.player;
  showApp();
  toast(`환영합니다, ${nickname}님! ${fmtWon(me.cash)} 지급 완료 💰`, 'ok');
}

// ───────── 실시간 이벤트 ─────────
socket.on(EV.TICK, ({ ts, prices: p, delist }) => {
  delistLeft.clear();
  if (delist) for (const [sym, sec] of Object.entries(delist)) delistLeft.set(sym, sec);
  for (const [sym, price] of Object.entries(p)) {
    prices.set(sym, price);
    if (detail && detail.symbol === sym) {
      detail.feed(ts, price);
      renderDetailHead();
      renderEstimate();
    }
  }
  updateMarketPrices();
  renderHeaderStats();
  if (!$('tab-portfolio').classList.contains('hidden')) renderPortfolio();
});

socket.on(EV.STOCKS, (list) => {
  stocks = list;
  for (const st of stocks) prices.set(st.symbol, st.price);
  renderMarket();
  if (detail && !stocks.some(s => s.symbol === detail.symbol)) closeDetail(); // 종목 삭제됨
  else if (detail) { renderDetailHead(); renderTradeAvailability(); }
});

socket.on(EV.GAME, (g) => {
  game = g;
  renderGameBadge();
  if (detail) renderTradeAvailability();
  if (game.status !== 'ended') $('finalSheet').classList.add('hidden');
});

socket.on(EV.ME, (state) => {
  me = state;
  renderAll();
  if (detail) { renderPosition(); renderTradeAvailability(); }
});

socket.on(EV.NEWS, (item) => {
  newsItems.unshift(item);
  if (newsItems.length > MAX_NEWS_ITEMS) newsItems.pop();
  renderNews();
  showNewsPopup(item);
});

socket.on(EV.NEWS_CLEAR, () => {
  newsItems = [];
  renderNews();
  const pop = $('newsPopup');
  clearTimeout(pop._t);
  pop.classList.remove('show');
});

// 새 뉴스 팝업: 잠깐 떠 있다가 자동으로 사라짐
function showNewsPopup(item) {
  const pop = $('newsPopup');
  pop.textContent = item.text;
  pop.classList.toggle('alert', item.kind === 'alert');
  pop.classList.add('show');
  clearTimeout(pop._t);
  pop._t = setTimeout(() => pop.classList.remove('show'), 5000);
}

function renderNews() {
  const wrap = $('newsList');
  if (newsItems.length === 0) {
    wrap.innerHTML = '<div class="empty-msg">아직 뉴스가 없습니다.</div>';
    return;
  }
  wrap.innerHTML = newsItems.map(n => `
    <div class="news-row${n.kind === 'alert' ? ' alert' : ''}">
      <span class="n-text">${esc(n.text)}</span>
      <span class="time">${fmtClock(n.ts)}</span>
    </div>`).join('');
}

socket.on(EV.FINAL, ({ rankings }) => {
  closeDetail();
  const mine = me ? rankings.find(r => r.nickname === me.nickname) : null;
  $('myResult').innerHTML = mine
    ? `<div>${esc(mine.nickname)}님의 최종 순위</div>
       <div class="big">${mine.rank}위 / ${rankings.length}명</div>
       <div>총자산 ${fmtWon(mine.total)} (<span class="${pctClass(mine.returnPct)}">${fmtPct(mine.returnPct)}</span>)</div>`
    : '<div>관전 중이었습니다</div>';
  const medals = ['🥇', '🥈', '🥉'];
  $('finalTop').innerHTML = rankings.slice(0, 10).map(r => `
    <li><span>${medals[r.rank - 1] || r.rank + '위'}</span>
        <span class="nick">${esc(r.nickname)}</span>
        <span>${fmtWon(r.total)}</span>
        <span class="${pctClass(r.returnPct)}">${fmtPct(r.returnPct)}</span></li>`).join('');
  $('finalSheet').classList.remove('hidden');
});

socket.on(EV.KICKED, () => {
  localStorage.removeItem(TOKEN_KEY);
  alert('관리자에 의해 퇴장되었습니다.');
  location.reload();
});

// ───────── 렌더링 ─────────
function renderAll() {
  renderHeaderStats();
  renderMarket();
  renderPortfolio();
  renderHistory();
}

function myTotalNow() {
  if (!me) return 0;
  let total = me.cash;
  for (const h of me.holdings) {
    const st = stocks.find(s => s.symbol === h.symbol);
    if (st && !st.delisted) total += (prices.get(h.symbol) ?? st.price) * h.qty;
  }
  return total;
}

function renderHeaderStats() {
  if (!me) return;
  const total = myTotalNow();
  const ret = me.initialCash ? ((total - me.initialCash) / me.initialCash) * 100 : 0;
  $('myNick').textContent = me.nickname;
  $('myRank').textContent = me.rank ? `${me.rank}위 / ${me.totalPlayers}명` : '';
  $('myTotal').textContent = fmtWon(total);
  $('myCash').textContent = fmtWon(me.cash);
  const retEl = $('myReturn');
  retEl.textContent = fmtPct(ret);
  retEl.className = pctClass(ret);
}

function renderGameBadge() {
  const b = $('gameBadge');
  b.textContent = STATUS_LABEL[game.status];
  b.className = 'game-badge ' + game.status;
}
setInterval(() => {
  const ms = game.status === 'running' ? Math.max(0, game.endsAt - Date.now()) : game.remainingMs;
  $('gameTimer').textContent = game.status === 'ended' ? '' : fmtTime(ms);
}, 500);

function renderMarket() {
  const wrap = $('tab-market');
  wrap.innerHTML = '';
  for (const st of stocks) {
    const row = document.createElement('div');
    row.className = 'stock-row' + (st.delisted ? ' delisted' : '');
    row.dataset.sym = st.symbol;
    row.innerHTML = `
      <div class="info">
        <div class="name">${esc(st.name)} <span class="r-badge"></span></div>
        <div class="sym">${st.symbol} <span class="hold-tag"></span></div>
      </div>
      <div class="right"><div class="price"></div><div class="chg"></div></div>`;
    row.addEventListener('click', () => openDetail(st.symbol));
    wrap.appendChild(row);
  }
  updateMarketPrices();
}

function updateMarketPrices() {
  for (const row of document.querySelectorAll('.stock-row')) {
    const sym = row.dataset.sym;
    const st = stocks.find(s => s.symbol === sym);
    if (!st) continue;
    const price = prices.get(sym) ?? st.price;
    const chg = changePct(price, st.basePrice);
    const cls = pctClass(chg);
    row.querySelector('.price').textContent = st.delisted ? '─' : fmtWon(price);
    row.querySelector('.price').classList.remove('up', 'down', 'flat');
    row.querySelector('.price').classList.add(cls);
    const chgEl = row.querySelector('.chg');
    chgEl.textContent = st.delisted ? '상장폐지' : fmtPct(chg);
    chgEl.className = 'chg ' + (st.delisted ? 'muted' : cls);
    let badge = '';
    if (st.delisted) badge = '<span class="badge delist">상장폐지</span>';
    else if (delistLeft.has(sym)) badge = `<span class="badge warning">상폐 ${delistLeft.get(sym)}초</span>`;
    else if (st.halted) badge = '<span class="badge halt">거래정지</span>';
    row.querySelector('.r-badge').innerHTML = badge;
    const h = me?.holdings.find(x => x.symbol === sym);
    row.querySelector('.hold-tag').textContent = h ? `보유 ${fmtNum(h.qty)}주` : '';
  }
}

function renderPortfolio() {
  if (!me) return;
  const wrap = $('portfolioList');
  if (me.holdings.length === 0) {
    wrap.innerHTML = '<div class="empty-msg">보유 종목이 없습니다.<br>시세 탭에서 첫 매수를 해보세요!</div>';
    return;
  }
  wrap.innerHTML = me.holdings.map(h => {
    const st = stocks.find(s => s.symbol === h.symbol);
    const cur = st?.delisted ? 0 : (prices.get(h.symbol) ?? st?.price ?? 0);
    const value = cur * h.qty;
    const cost = h.avgPrice * h.qty;
    const pl = value - cost;
    const plPct = cost > 0 ? (pl / cost) * 100 : 0;
    return `
      <div class="pf-row" data-sym="${h.symbol}">
        <div class="top"><span>${esc(h.name)} ${st?.delisted ? '<span class="badge delist">상장폐지</span>' : ''}</span>
          <span class="${pctClass(pl)}">${pl >= 0 ? '+' : ''}${fmtWon(pl)}</span></div>
        <div class="grid">
          <div><span>보유수량</span> ${fmtNum(h.qty)}주</div>
          <div><span>평균단가</span> ${fmtWon(h.avgPrice)}</div>
          <div><span>평가금액</span> ${fmtWon(value)}</div>
          <div><span>수익률</span> <b class="${pctClass(plPct)}">${fmtPct(plPct)}</b></div>
        </div>
      </div>`;
  }).join('');
  for (const el of wrap.querySelectorAll('.pf-row'))
    el.addEventListener('click', () => openDetail(el.dataset.sym));
}

function renderHistory() {
  if (!me) return;
  const wrap = $('tradeList');
  if (me.trades.length === 0) {
    wrap.innerHTML = '<div class="empty-msg">아직 거래 내역이 없습니다.</div>';
    return;
  }
  wrap.innerHTML = me.trades.map(t => `
    <div class="trade-row">
      <span class="side ${t.side}">${t.side === 'buy' ? '매수' : '매도'}</span>
      <span class="t-name">${esc(t.name)}</span>
      <span>${fmtNum(t.qty)}주 × ${fmtWon(t.price)}</span>
      <span class="time">${fmtClock(t.ts)}</span>
    </div>`).join('');
}

// ───────── 탭 ─────────
for (const btn of document.querySelectorAll('#bottomNav button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bottomNav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    for (const tab of document.querySelectorAll('.tab')) tab.classList.add('hidden');
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'portfolio') renderPortfolio();
    if (btn.dataset.tab === 'news') renderNews();
    if (btn.dataset.tab === 'history') renderHistory();
  });
}

// ───────── 종목 상세 / 주문 ─────────
async function openDetail(symbol) {
  const st = stocks.find(s => s.symbol === symbol);
  if (!st) return;
  closeDetail();
  $('detailSheet').classList.remove('hidden');
  const res = await emitAck(socket, EV.CHART, { symbol });
  const { chart, series } = createCandleChart($('detailChart'));
  if (res.ok) {
    setCandles(series, res.candles);
    chart.timeScale().fitContent();
  }
  detail = { symbol, chart, series, feed: makeCandleFeed(series, res.ok ? res.candles.at(-1) : null, game.candleSec) };
  side = 'buy';
  setSide('buy');
  $('qtyInput').value = '';
  renderDetailHead();
  renderPosition();
  renderTradeAvailability();
  renderEstimate();
}

function closeDetail() {
  if (detail) { detail.chart.remove(); detail = null; }
  $('detailChart').innerHTML = '';
  $('detailSheet').classList.add('hidden');
}
$('detailBack').addEventListener('click', closeDetail);

function curStock() { return stocks.find(s => s.symbol === detail?.symbol); }
function curPrice() { return prices.get(detail?.symbol) ?? curStock()?.price ?? 0; }

function renderDetailHead() {
  const st = curStock();
  if (!st) return;
  const price = curPrice();
  const chg = changePct(price, st.basePrice);
  $('detailName').textContent = `${st.name} (${st.symbol})`;
  $('detailPrice').textContent = st.delisted ? '상장폐지' : fmtWon(price);
  $('detailPrice').className = 'd-price ' + pctClass(chg);
  $('detailChg').textContent = st.delisted ? '' : fmtPct(chg);
  $('detailChg').className = 'd-chg ' + pctClass(chg);
  let badge = '';
  if (st.delisted) badge = '<span class="badge delist">상장폐지</span>';
  else if (delistLeft.has(st.symbol)) badge = `<span class="badge warning">상폐 ${delistLeft.get(st.symbol)}초</span>`;
  else if (st.halted) badge = '<span class="badge halt">거래정지</span>';
  $('detailBadge').innerHTML = badge;
}

function renderPosition() {
  const h = me?.holdings.find(x => x.symbol === detail?.symbol);
  const box = $('myPosition');
  if (!h) return box.classList.add('hidden');
  const value = curPrice() * h.qty;
  const pl = value - h.avgPrice * h.qty;
  box.innerHTML = `
    <div><span>보유수량</span> ${fmtNum(h.qty)}주</div>
    <div><span>평균단가</span> ${fmtWon(h.avgPrice)}</div>
    <div><span>평가금액</span> ${fmtWon(value)}</div>
    <div><span>평가손익</span> <b class="${pctClass(pl)}">${pl >= 0 ? '+' : ''}${fmtWon(pl)}</b></div>`;
  box.classList.remove('hidden');
}

function setSide(s) {
  side = s;
  $('sideBuy').classList.toggle('active', s === 'buy');
  $('sideSell').classList.toggle('active', s === 'sell');
  const btn = $('orderBtn');
  btn.textContent = s === 'buy' ? '매수하기' : '매도하기';
  btn.className = 'order ' + s;
  renderEstimate();
}
$('sideBuy').addEventListener('click', () => setSide('buy'));
$('sideSell').addEventListener('click', () => setSide('sell'));

$('maxBtn').addEventListener('click', () => {
  const price = curPrice();
  if (!price || !me) return;
  let qty;
  if (side === 'buy') {
    const fee = game.settings?.feeRate || 0;
    qty = Math.floor(me.cash / (price * (1 + fee)));
    while (qty > 0 && qty * price + Math.floor(qty * price * fee) > me.cash) qty--;
  } else {
    qty = me.holdings.find(x => x.symbol === detail?.symbol)?.qty || 0;
  }
  $('qtyInput').value = qty > 0 ? qty : '';
  renderEstimate();
});

$('qtyInput').addEventListener('input', renderEstimate);

function renderEstimate() {
  const qty = Math.floor(Number($('qtyInput').value)) || 0;
  const price = curPrice();
  const fee = game.settings?.feeRate || 0;
  const amount = qty * price;
  const feeAmt = Math.floor(amount * fee);
  const total = side === 'buy' ? amount + feeAmt : amount - feeAmt;
  $('estAmount').textContent = fmtWon(total) + (feeAmt > 0 ? ` (수수료 ${fmtWon(feeAmt)} 포함)` : '');
}

function renderTradeAvailability() {
  const st = curStock();
  const blocked = $('tradeBlocked');
  let msg = null;
  if (game.status === 'lobby') msg = '게임 시작 전입니다 — 시작하면 거래할 수 있어요';
  else if (game.status === 'paused') msg = '장 일시정지 중입니다';
  else if (game.status === 'ended') msg = '게임이 종료되었습니다';
  else if (st?.delisted) msg = '상장폐지된 종목입니다';
  else if (st?.halted) msg = '거래정지 종목입니다';
  $('orderBtn').disabled = !!msg;
  blocked.textContent = msg || '';
  blocked.classList.toggle('hidden', !msg);
}

let ordering = false;
$('orderBtn').addEventListener('click', async () => {
  if (ordering || !detail) return;
  const qty = Math.floor(Number($('qtyInput').value));
  if (!qty || qty <= 0) return toast('수량을 입력하세요', 'err');
  ordering = true;
  $('orderBtn').disabled = true;
  const r = await emitAck(socket, EV.TRADE, { symbol: detail.symbol, side, qty });
  ordering = false;
  renderTradeAvailability();
  if (!r.ok) return toast(r.error, 'err');
  const t = r.trade;
  toast(`✅ ${t.name} ${fmtNum(t.qty)}주 ${t.side === 'buy' ? '매수' : '매도'} 체결 (${fmtWon(t.price * t.qty)})`, 'ok');
  $('qtyInput').value = '';
  renderEstimate();
  // me는 서버 push(EV.ME)로 갱신되지만 즉시 반영을 위해 약간 대기 후 포지션 갱신
  setTimeout(() => { renderPosition(); renderEstimate(); }, 150);
});

// ───────── 토스트 ─────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
