import { useEffect, useRef, type ReactNode } from 'react';
import { chromaPosition, PARADE_COLUMNS, PARADE_LEVELS, VECTOR_SIZE, type ScopeData } from './data';
import './scopes.css';

export type ScopeStatus = 'measured' | 'measuring' | 'paused' | 'waiting' | 'error';
const TRACE = [[244, 108, 115], [87, 205, 138], [101, 165, 246], [220, 225, 234]];
const maxOf = (values: ArrayLike<number>) => { let max = 1; for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]); return max; };

function drawParade(canvas: HTMLCanvasElement, data: ScopeData | null) {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height); if (!data) return;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const ceiling = Math.log1p(Math.max(...data.parade.map(maxOf)));
  data.parade.forEach((channel, c) => {
    for (let level = 0; level < PARADE_LEVELS; level++) for (let x = 0; x < PARADE_COLUMNS; x++) {
      const count = channel[level * PARADE_COLUMNS + x]; if (!count) continue;
      const at = ((PARADE_LEVELS - 1 - level) * canvas.width + c * PARADE_COLUMNS + x) * 4;
      img.data.set(TRACE[c], at); img.data[at + 3] = Math.round(75 + 180 * Math.log1p(count) / ceiling);
    }
  });
  ctx.putImageData(img, 0, 0);
}
function drawHistogram(canvas: HTMLCanvasElement, data: ScopeData | null) {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height); if (!data) return;
  const ceiling = Math.max(...data.hist.map(maxOf)), bottom = canvas.height - 1;
  data.hist.forEach((channel, c) => {
    const points = channel.map((n, i) => [i * canvas.width / 255, bottom - Math.sqrt(n / ceiling) * (bottom - 2)]);
    ctx.beginPath(); ctx.moveTo(0, bottom);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(canvas.width, bottom); ctx.closePath();
    ctx.fillStyle = `rgba(${TRACE[c].join(',')},${c === 3 ? 0.035 : 0.12})`; ctx.fill();
    ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = `rgb(${TRACE[c].join(',')})`; ctx.lineWidth = c === 3 ? 1.3 : 1.7;
    ctx.setLineDash(c === 3 ? [3, 3] : []); ctx.stroke();
  });
  ctx.setLineDash([]);
}
function drawVector(canvas: HTMLCanvasElement, data: ScopeData | null) {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height); if (!data) return;
  const img = ctx.createImageData(VECTOR_SIZE, VECTOR_SIZE), ceiling = Math.log1p(maxOf(data.vectorDensity));
  for (let i = 0; i < data.vectorDensity.length; i++) {
    const count = data.vectorDensity[i]; if (!count) continue;
    img.data.set(TRACE[3], i * 4); img.data[i * 4 + 3] = Math.round(70 + 185 * Math.log1p(count) / ceiling);
  }
  ctx.putImageData(img, 0, 0);
}

function LinearGrid({ parade = false }: { parade?: boolean }) {
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    {[0, 25, 50, 75, 100].map(y => <line key={'h' + y} x1="0" x2="100" y1={y} y2={y} />)}
    {(parade ? [100 / 3, 200 / 3] : [25, 50, 75]).map(x => <line key={'v' + x} y1="0" y2="100" x1={x} x2={x} />)}
  </svg>;
}
const TARGETS = [
  ['R', 191.25, 0, 0], ['Mg', 191.25, 0, 191.25], ['B', 0, 0, 191.25],
  ['Cy', 0, 191.25, 191.25], ['G', 0, 191.25, 0], ['Yl', 191.25, 191.25, 0],
] as const;
function VectorGrid() {
  return <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="46" /><circle cx="50" cy="50" r="23" />
    <line x1="4" x2="96" y1="50" y2="50" /><line x1="50" x2="50" y1="4" y2="96" />
    {TARGETS.map(([label, r, g, b]) => {
      const [x, y] = chromaPosition(r, g, b).map(n => n * 100);
      return <g key={label}><rect x={x - 2} y={y - 2} width="4" height="4" /><text x={x} y={y < 50 ? y - 4 : y + 7}>{label}</text></g>;
    })}
  </svg>;
}

export function ScopePanel({ data, sourceLabel, status, detail, controls, presentation = 'panel' }: {
  data: ScopeData | null; sourceLabel: string; status: ScopeStatus; detail?: string; controls?: ReactNode; presentation?: 'panel' | 'strip';
}) {
  const parade = useRef<HTMLCanvasElement>(null), hist = useRef<HTMLCanvasElement>(null), vector = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (parade.current) drawParade(parade.current, data);
    if (hist.current) drawHistogram(hist.current, data);
    if (vector.current) drawVector(vector.current, data);
  }, [data]);
  const statusText = ({ measured: 'Measured', measuring: 'Measuring…', paused: 'Paused during playback', waiting: 'Waiting for a frame', error: 'Frame unavailable' })[status];
  return <section className={`scope-panel scope-panel--${presentation}`} data-status={status} aria-label={`${sourceLabel} scopes`} title={`${sourceLabel}: ${statusText}. ${detail ?? 'Display RGB · 8-bit sample'}`}>
    <div className="scope-panel-heading">
      <div className="scope-source"><strong title={sourceLabel}>{sourceLabel}</strong><span className="scope-status">{statusText}</span></div>
      <div className="scope-controls">{controls ?? <span className="scope-source-target">Source</span>}</div>
    </div>
    <div className="scope-plots">
      <figure className="scope-plot scope-parade" aria-label="RGB parade: channel level by horizontal image position">
        <figcaption>RGB parade <span className="scope-channel-key"><i className="scope-red">R</i><i className="scope-green">G</i><i className="scope-blue">B</i></span></figcaption>
        <div className="scope-levels" aria-hidden="true"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
        <div className="scope-plot-area"><LinearGrid parade /><canvas ref={parade} width={PARADE_COLUMNS * 3} height={PARADE_LEVELS} /></div>
        <div className="scope-parade-axis" aria-hidden="true"><span>R · left → right</span><span>G · left → right</span><span>B · left → right</span></div>
      </figure>
      <figure className="scope-plot scope-histogram" aria-label="RGB and luma histogram: pixel density by code value">
        <figcaption>Histogram <span className="scope-channel-key"><i className="scope-red">R</i><i className="scope-green">G</i><i className="scope-blue">B</i><i>Y′</i></span></figcaption>
        <div className="scope-plot-area"><LinearGrid /><canvas ref={hist} width="512" height="160" /></div>
        <div className="scope-hist-axis" aria-hidden="true"><span>0</span><span>64</span><span>128</span><span>192</span><span>255</span></div>
      </figure>
      <figure className="scope-plot scope-vector" aria-label="Vectorscope: Cb right, Cr up, neutral in the centre">
        <figcaption title="Cb right, Cr up · boxes mark 75% colour targets">Vectorscope</figcaption>
        <div className="scope-vector-area"><canvas ref={vector} width={VECTOR_SIZE} height={VECTOR_SIZE} /><VectorGrid /></div>
      </figure>
      {!data && <div className="scope-no-data">{status === 'paused' ? 'Paused' : status === 'error' ? 'Unavailable' : status === 'measuring' ? 'Sampling…' : 'No frame'}</div>}
    </div>
    <div className="scope-panel-foot"><span>{data && detail || 'Display RGB · 8-bit sample'}</span><span title="Fraction of sampled visible pixels with Rec.709-weighted luma above 250/255. This is not an HDR or legal-range clipping test.">{data ? `${(data.clip * 100).toFixed(1)}% near white` : '—'}<span className="scope-scale-note"> · density √ / log</span></span></div>
  </section>;
}
