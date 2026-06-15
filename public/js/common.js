// 클라이언트 공통 유틸
export const KST = 9 * 3600; // lightweight-charts는 UTC 라벨이므로 한국시간 보정

export const fmtWon = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
export const fmtNum = (n) => Math.round(n).toLocaleString('ko-KR');
export const fmtPct = (p) => (p > 0 ? '+' : '') + p.toFixed(2) + '%';
export const pctClass = (p) => (p > 0.0001 ? 'up' : p < -0.0001 ? 'down' : 'flat');

export const changePct = (price, base) => (base > 0 ? ((price - base) / base) * 100 : 0);

export function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export const STATUS_LABEL = { lobby: '대기 중', running: '진행 중', paused: '일시정지', intermission: '휴장', ended: '종료' };

// 한국식 색상: 상승 빨강 / 하락 파랑
export const CHART_COLORS = {
  up: '#f04452',
  down: '#3182f6',
  bg: '#0d111c',
  grid: '#1c2333',
  text: '#8b95a9',
};

/** lightweight-charts 캔들차트 생성 (v4/v5 API 모두 대응) */
export function createCandleChart(el) {
  const chart = LightweightCharts.createChart(el, {
    layout: { background: { type: 'solid', color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 12 },
    grid: {
      vertLines: { color: CHART_COLORS.grid },
      horzLines: { color: CHART_COLORS.grid },
    },
    timeScale: { timeVisible: true, secondsVisible: true, borderColor: CHART_COLORS.grid },
    rightPriceScale: { borderColor: CHART_COLORS.grid },
    crosshair: { mode: 0 },
    autoSize: true,
  });
  const opts = {
    upColor: CHART_COLORS.up, downColor: CHART_COLORS.down,
    borderUpColor: CHART_COLORS.up, borderDownColor: CHART_COLORS.down,
    wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down,
  };
  const series = chart.addCandlestickSeries
    ? chart.addCandlestickSeries(opts)
    : chart.addSeries(LightweightCharts.CandlestickSeries, opts);
  return { chart, series };
}

/** 서버 캔들(epoch초)을 KST 보정해서 차트에 세팅 */
export function setCandles(series, candles) {
  series.setData(candles.map(c => ({ ...c, time: c.time + KST })));
}

/**
 * 틱 → 캔들 실시간 집계 피더. 봉 주기(candleSec)는 game 페이로드에서 내려온다.
 * 서버는 가격 변경분(tick)만 보내므로 현재 봉은 클라이언트에서 만든다.
 */
export function makeCandleFeed(series, lastCandle, candleSec = 60) {
  let cur = lastCandle ? { ...lastCandle, time: lastCandle.time + KST } : null;
  return (ts, price) => {
    const bucket = Math.floor(ts / 1000 / candleSec) * candleSec + KST;
    if (!cur || cur.time !== bucket) {
      cur = { time: bucket, open: price, high: price, low: price, close: price };
    } else {
      if (price > cur.high) cur.high = price;
      if (price < cur.low) cur.low = price;
      cur.close = price;
    }
    series.update(cur);
  };
}

/** 스파크라인 캔버스 그리기 */
export function drawSpark(canvas, points, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 2) return;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * (w - 2) + 1;
    const y = h - 3 - ((p - min) / range) * (h - 6);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

/** ack를 Promise로 */
export function emitAck(socket, ev, payload) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) resolve({ ok: false, error: '서버 응답 없음' }); }, 7000);
    socket.emit(ev, payload, (res) => { done = true; clearTimeout(t); resolve(res); });
  });
}
