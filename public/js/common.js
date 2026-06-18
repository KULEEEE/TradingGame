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
  accent: '#ffd166',
};

/** lightweight-charts 차트 생성 (v4/v5 API 모두 대응). 시리즈는 addPriceSeries로 별도 추가 */
export function createChart(el) {
  return LightweightCharts.createChart(el, {
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
}

/** 모드별 가격 시리즈 추가. mode: 'candle' | 'line' */
export function addPriceSeries(chart, mode = 'candle') {
  if (mode === 'line') {
    const opts = { color: CHART_COLORS.up, lineWidth: 2, priceLineVisible: true, lastValueVisible: true };
    return chart.addLineSeries ? chart.addLineSeries(opts) : chart.addSeries(LightweightCharts.LineSeries, opts);
  }
  const opts = {
    upColor: CHART_COLORS.up, downColor: CHART_COLORS.down,
    borderUpColor: CHART_COLORS.up, borderDownColor: CHART_COLORS.down,
    wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down,
  };
  return chart.addCandlestickSeries ? chart.addCandlestickSeries(opts) : chart.addSeries(LightweightCharts.CandlestickSeries, opts);
}

// ── 거래일 경계 세로선 (커스텀 시리즈 프리미티브) ──
class VertLinePaneView {
  constructor(src) { this._src = src; this._x = null; }
  update() { this._x = this._src._chart?.timeScale().timeToCoordinate(this._src._time) ?? null; }
  zOrder() { return 'top'; }
  renderer() {
    const x = this._x, color = this._src._color, text = this._src._text;
    return {
      draw: (target) => target.useMediaCoordinateSpace((scope) => {
        if (x === null) return;
        const ctx = scope.context;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, scope.mediaSize.height);
        ctx.stroke();
        if (text) {
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(text, x + 4, 12);
        }
        ctx.restore();
      }),
    };
  }
}
class VertLine {
  constructor(time, color, text) { this._time = time; this._color = color; this._text = text; this._chart = null; this._views = [new VertLinePaneView(this)]; }
  attached(p) { this._chart = p.chart; }
  detached() { this._chart = null; }
  updateAllViews() { this._views.forEach(v => v.update()); }
  paneViews() { return this._views; }
}

/**
 * 거래일 경계(세로선, 전 거래일) + 시초가(가로선, 현재 거래일만)를 시리즈에 표시.
 * dayMarks=[{day,time(epoch초),open}]. currentDay 일차의 시초가만 가로선으로 그린다.
 * 세로선 시각은 실제 데이터 포인트 시각으로 스냅한다(라인 이력도 candles 시각이라 두 모드 공통).
 * 재호출 시 이전에 그린 선들을 먼저 제거한다.
 */
export function applyDayMarks(series, dayMarks, candles, currentDay) {
  const prev = series.__dayLines;
  if (prev) {
    prev.vert.forEach(v => { try { series.detachPrimitive(v); } catch { /* 이미 제거됨 */ } });
    prev.horiz.forEach(h => { try { series.removePriceLine(h); } catch { /* 이미 제거됨 */ } });
  }
  const store = { vert: [], horiz: [] };
  series.__dayLines = store;

  const times = (candles || []).map(c => c.time).sort((a, b) => a - b);
  const snap = (t) => times.find(ct => ct >= t) ?? times[times.length - 1];
  const seen = new Set();
  for (const m of (dayMarks || [])) {
    const ct = snap(m.time);
    if (ct == null || seen.has(ct)) continue;
    seen.add(ct);
    // 세로선: 거래일 경계
    if (series.attachPrimitive) {
      const v = new VertLine(ct + KST, CHART_COLORS.accent, `${m.day}일차`);
      series.attachPrimitive(v);
      store.vert.push(v);
    }
    // 가로선: 현재 거래일 시초가만
    if (m.day === currentDay) {
      store.horiz.push(series.createPriceLine({
        price: m.open,
        color: CHART_COLORS.accent,
        lineWidth: 1,
        lineStyle: 2, // 점선
        axisLabelVisible: true,
        title: `${m.day}일차 시초`,
      }));
    }
  }
}

/** 라인 시리즈 색을 기준가 대비 등락에 따라 한국식으로(상승 빨강 / 하락 파랑) 적용 */
export function applyLineColor(series, close, base) {
  series.applyOptions({ color: close >= base ? CHART_COLORS.up : CHART_COLORS.down });
}

/**
 * 서버 캔들(epoch초)을 KST 보정해서 모드에 맞게 세팅.
 *  · 라인: 종가만 사용.
 *  · 캔들(간소화): 시가 = 직전 봉 종가(연결), 꼬리 없이 몸통만. 오르면 양봉(빨강)/내리면 음봉(파랑).
 */
export function setSeriesData(series, candles, mode = 'candle') {
  if (mode === 'line') {
    series.setData(candles.map(c => ({ time: c.time + KST, value: c.close })));
    return;
  }
  let prev = null;
  series.setData(candles.map(c => {
    const open = prev ?? c.open ?? c.close;
    const close = c.close;
    prev = close;
    return { time: c.time + KST, open, high: Math.max(open, close), low: Math.min(open, close), close };
  }));
}

/**
 * 틱 → 실시간 집계 피더. bucketSec 간격으로 점/봉을 만든다.
 *  · 캔들(간소화): 한 봉의 시가 = 직전 봉 종가, 꼬리 없이 몸통만. (떨어지면 음봉/오르면 양봉)
 *  · 라인: 틱마다 종가를 점으로 찍는다.
 * 서버는 가격 변경분(tick)만 보내므로 현재 봉/점은 클라이언트에서 만든다.
 */
export function makeFeed(series, lastCandle, bucketSec = 60, mode = 'candle') {
  let cur = lastCandle ? { ...lastCandle, time: lastCandle.time + KST } : null;
  let prevClose = lastCandle ? lastCandle.close : null;
  return (ts, price) => {
    const bucket = Math.floor(ts / 1000 / bucketSec) * bucketSec + KST;
    if (!cur || cur.time !== bucket) {
      if (cur) prevClose = cur.close;          // 직전 봉 종가 → 새 봉 시가
      const open = prevClose ?? price;
      cur = { time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price };
    } else {
      cur.close = price;
      cur.high = Math.max(cur.open, price);    // 꼬리 없이 몸통만
      cur.low = Math.min(cur.open, price);
    }
    series.update(mode === 'line' ? { time: cur.time, value: cur.close } : cur);
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
