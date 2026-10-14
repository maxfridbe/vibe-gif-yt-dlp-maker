/// <reference lib="dom" />
// Clip Editor – all media work happens here in the browser via ffmpeg.wasm.
// Written in TypeScript / TSX with Snabbdom virtual DOM. Zero Node.js runtime.

import { FFmpeg } from './vendor/ffmpeg/index.js';
import * as S from './subs.js';
import { init } from './vendor/snabbdom/init.js';
import { classModule } from './vendor/snabbdom/modules/class.js';
import { propsModule } from './vendor/snabbdom/modules/props.js';
import { styleModule } from './vendor/snabbdom/modules/style.js';
import { eventListenersModule } from './vendor/snabbdom/modules/eventlisteners.js';
import { attributesModule } from './vendor/snabbdom/modules/attributes.js';
import { datasetModule } from './vendor/snabbdom/modules/dataset.js';
import { jsx, Fragment } from './jsx.js';
import type { VNode } from './vendor/snabbdom/vnode.js';

const patch = init([
  classModule,
  propsModule,
  styleModule,
  eventListenersModule,
  attributesModule,
  datasetModule,
]);

/** True inside the desktop/Android app, where the page is served by the embedded Rust server. */
const NATIVE = location.hostname === '127.0.0.1';

/* ───────────────────────── State Definitions ───────────────────────── */
export interface HistoryAttempt {
  id: string;
  timestamp: number;
  videoTitle: string;
  sourceLabel: string;
  cueCount: number;
  previewText: string;
  cues: S.Cue[];
  sel: { start: number; end: number };
}

export interface RenderResultItem {
  id: string;
  name: string;
  ext: string;
  blob: Blob;
  url: string;
  text?: string;
  size: number;
  saved?: boolean;
  savePath?: string;
}

export interface CaptionTrack {
  name: string;
  lang: string;
  ext: string;
  url: string;
}

const state = {
  title: '',
  duration: 0,
  srcBytes: null as Uint8Array | null,
  srcName: '',
  srcInFS: false,
  cues: [] as S.Cue[],
  sel: { start: 0, end: 0 },
  view: { from: 0, to: 0 },
  captions: [] as CaptionTrack[],
  loopSel: false,
  busy: false,
  abort: null as AbortController | null,
  pendingStart: null as number | null,

  // UI inputs
  urlInput: '',
  selectedTrack: 0,
  stSize: 20,
  stOutline: 2,
  stMargin: 12,
  stColor: '#ffffff',

  // Export options
  outMp4: true,
  outAudio: true,
  outWebp: true,
  outGif: false,
  outSrt: true,
  outWidth: 480,
  outFps: 12,
  outQuality: 70,
  outName: '',
  onlySel: true,

  // Status & Progress
  status: 'ffmpeg.wasm idle',
  progressVisible: false,
  progressFrac: null as number | null,
  progressText: '',

  // Results
  results: [] as RenderResultItem[],

  // History dialog
  historyOpen: false,
  historySearch: '',
  historyList: [] as HistoryAttempt[],

  currentTime: 0,
  isPlaying: false,
};

/* ───────────────────────── DOM / Media References ───────────────────────── */
let video: HTMLVideoElement | null = null;
let tl: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let rootVNode: VNode | null = null;
let isUpdating = false;

function update() {
  if (isUpdating) return;
  isUpdating = true;
  requestAnimationFrame(() => {
    isUpdating = false;
    const appEl = document.getElementById('app');
    if (!appEl && !rootVNode) return;
    const newVNode = renderApp();
    if (!rootVNode && appEl) {
      rootVNode = patch(appEl, newVNode);
    } else if (rootVNode) {
      rootVNode = patch(rootVNode, newVNode);
    }
    drawTimeline();
  });
}

/* ───────────────────────── ffmpeg.wasm ───────────────────────── */
let ff: FFmpeg | null = null;
let ffLoading: Promise<FFmpeg> | null = null;
let progressCtx: { label: string; dur: number } | null = null;

function getFF(): Promise<FFmpeg> {
  if (ff) return Promise.resolve(ff);
  ffLoading ??= (async () => {
    setStatus('Loading ffmpeg.wasm (~31 MB, cached after first load)…');
    const f = new FFmpeg();
    f.on('log', ({ message }: { message: string }) => onFFLog(message));
    const base = new URL('vendor/core/', location.href).href;
    await f.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    const font = new Uint8Array(await (await fetch('fonts/DejaVuSans-Bold.ttf')).arrayBuffer());
    await f.createDir('/fonts');
    await f.writeFile('/fonts/DejaVuSans-Bold.ttf', font);
    await f.createDir('/work');
    ff = f;
    setStatus('ffmpeg.wasm ready');
    return f;
  })().catch((e) => {
    ffLoading = null;
    throw e;
  });
  return ffLoading;
}

function killFF() {
  if (ff) ff.terminate();
  ff = null;
  ffLoading = null;
  state.srcInFS = false;
}

const logLines: string[] = [];
let logFlush = 0;
function log(msg: string) {
  logLines.push(msg);
  if (logLines.length > 3000) logLines.splice(0, 1000);
  if (!logFlush)
    logFlush = requestAnimationFrame(() => {
      const el = document.getElementById('log');
      if (el) {
        el.textContent = logLines.join('\n');
        el.scrollTop = el.scrollHeight;
      }
      logFlush = 0;
    });
}

function onFFLog(msg: string) {
  log(msg);
  if (!progressCtx) return;
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
  if (m && progressCtx.dur) {
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
    showProgress(Math.min(1, t / progressCtx.dur), `${progressCtx.label} ${Math.round((100 * t) / progressCtx.dur)}%`);
  }
}

async function run(args: string[], label: string, dur: number = 0) {
  const f = await getFF();
  progressCtx = { label, dur };
  showProgress(dur ? 0 : null, label);
  log(`\n$ ffmpeg ${args.map((a) => (/[\s,;']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  try {
    const rc = await f.exec(args);
    if (rc !== 0) throw new Error(`ffmpeg failed during "${label}" (exit ${rc}) — see the ffmpeg log`);
  } finally {
    progressCtx = null;
  }
}

async function ensureSourceInFS(): Promise<string> {
  const f = await getFF();
  if (!state.srcInFS && state.srcBytes) {
    await f.writeFile(`/work/${state.srcName}`, state.srcBytes.slice());
    state.srcInFS = true;
  }
  return `/work/${state.srcName}`;
}

/* ───────────────────────── UI Helpers ───────────────────────── */
function setStatus(text: string) {
  state.status = text;
  update();
}

function showProgress(frac: number | null, text: string) {
  state.progressVisible = true;
  state.progressFrac = frac;
  state.progressText = text || '';
  update();
}

function hideProgress() {
  state.progressVisible = false;
  state.progressFrac = null;
  state.progressText = '';
  update();
}

function setBusy(busy: boolean) {
  state.busy = busy;
  if (!busy) {
    hideProgress();
    state.abort = null;
  }
  update();
}

const fmtBytes = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const slug = (s: string) =>
  (s || 'clip')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50) || 'clip';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const mimeFor = (name: string): string =>
  ({
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
  }[name.split('.').pop()?.toLowerCase() || ''] || 'video/mp4');

async function api(path: string): Promise<any> {
  const res = await fetch(path, { signal: state.abort?.signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/* ───────────────────────── Fetching & Loading Media ───────────────────────── */
async function download(url: string, label: string, sizeHint: number = 0): Promise<Uint8Array> {
  const CHUNK = 8 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  let got = 0;
  let total = sizeHint || 0;
  const signal = state.abort?.signal;
  for (;;) {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
      headers: { Range: `bytes=${got}-${got + CHUNK - 1}` },
      signal,
    });
    if (res.status === 416) break;
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`${label}: ${j.error || `HTTP ${res.status}`}`);
    }
    const cr = res.headers.get('content-range');
    const m = cr && /\/(\d+)/.exec(cr);
    if (m) total = +m[1];
    else if (res.status === 200) total = +(res.headers.get('content-length') || total);

    const reader = res.body?.getReader();
    if (!reader) break;
    let chunkGot = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        got += value.length;
        chunkGot += value.length;
        showProgress(total ? got / total : null, `Downloading ${label} ${fmtBytes(got)}${total ? ' / ' + fmtBytes(total) : ''}`);
      }
    }
    if (res.status === 200 || chunkGot < CHUNK || (total && got >= total)) break;
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function loadUrl(raw: string) {
  const url = raw.trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return alert('That does not look like a URL.');
  }
  if (state.busy) return;
  setBusy(true);
  state.abort = new AbortController();
  try {
    const isYT = /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname);
    if (isYT) {
      const t = u.searchParams.get('t') || u.searchParams.get('start');
      const hms = t && /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(t);
      state.pendingStart = hms ? +(hms[1] || 0) * 3600 + +(hms[2] || 0) * 60 + +(hms[3] || 0) || null : null;
      showProgress(null, 'Resolving with yt-dlp…');
      setStatus('Resolving…');
      const info = await api(`/api/resolve?url=${encodeURIComponent(url)}`);
      state.title = info.title || '';
      setCaptionTracks(info.captions || []);
      const v = await download(info.video.url, 'video', info.video.size);
      let bytes = v;
      if (info.audio) {
        const a = await download(info.audio.url, 'audio', info.audio.size);
        const f = await getFF();
        await f.writeFile('/work/in_v', v);
        await f.writeFile('/work/in_a', a);
        await run(['-y', '-i', '/work/in_v', '-i', '/work/in_a', '-c', 'copy', '-movflags', '+faststart', '/work/mux.mp4'], 'Muxing video + audio');
        bytes = (await f.readFile('/work/mux.mp4')) as Uint8Array;
        await f.deleteFile('/work/in_v');
        await f.deleteFile('/work/in_a');
        await f.deleteFile('/work/mux.mp4');
      }
      await setSource(bytes, `${slug(info.title || 'video')}.mp4`, info.title || url);
      if (info.captions?.length) loadTrack(0, false).catch((e) => console.warn(e));
    } else {
      const name = decodeURIComponent(u.pathname.split('/').pop() || 'video.mp4');
      showProgress(null, `Fetching ${name}…`);
      const bytes = await download(url, name);
      await setSource(bytes, name, name);
    }
  } catch (e: any) {
    if (state.busy && ff) console.error(e);
    setStatus(`Error: ${e.message}`);
    alert(`Failed to load URL: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function setSource(bytes: Uint8Array, name: string, title: string, alreadyInFS = false) {
  if (ff && state.srcName && !alreadyInFS) await ff.deleteFile(`/work/${state.srcName}`).catch(() => {});
  state.srcBytes = bytes;
  state.srcName = name.replace(/[^\w.-]/g, '_');
  state.srcInFS = alreadyInFS && name === state.srcName;
  state.title = title || name;
  state.outName = slug(state.title);

  if (video) {
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(new Blob([bytes as any], { type: mimeFor(name) }));
    await new Promise<void>((resolve) => {
      if (!video) return resolve();
      video.onloadedmetadata = () => resolve();
      video.onerror = () => {
        alert("The browser can't preview this file's codec. Try an MP4/WebM.");
        resolve();
      };
    });
    state.duration = Number.isFinite(video.duration) ? video.duration : 0;
  }
  const start = clamp(state.pendingStart ?? 0, 0, state.duration);
  state.pendingStart = null;
  setSel(start, state.duration <= 30 && start === 0 ? state.duration : Math.min(state.duration, start + 10));
  state.view = { from: 0, to: state.duration };
  if (video) video.currentTime = start;
  setStatus(`Loaded ${state.srcName} (${fmtBytes(bytes.length)})`);
  update();
}

function setCaptionTracks(list: CaptionTrack[]) {
  state.captions = list;
  state.selectedTrack = 0;
  update();
}

async function loadTrack(i: number, confirmReplace = true) {
  const c = state.captions[i];
  if (!c) return;
  if (confirmReplace && state.cues.length && !confirm('Replace the current subtitles?')) return;
  setStatus(`Loading captions: ${c.name}…`);
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(c.url)}`);
  if (!res.ok) throw new Error(`captions: HTTP ${res.status}`);
  setCues(S.parseSubtitles(await res.text(), c.ext));
  setStatus(`Loaded ${state.cues.length} cues (${c.name})`);
}

function setCues(cues: S.Cue[], skipAutoSnap = false) {
  state.cues = cues.slice().sort((a, b) => a.start - b.start);
  update();
  if (!skipAutoSnap) scheduleAutoSnapshot();
}

function setSel(start: number, end: number) {
  start = clamp(start, 0, state.duration);
  end = clamp(end, 0, state.duration);
  if (end < start) [start, end] = [end, start];
  state.sel = { start, end };
  update();
}

/* ───────────────────────── Timeline Drawing & Interaction ───────────────────────── */
const dpr = () => window.devicePixelRatio || 1;
const tToX = (t: number) => ((t - state.view.from) / (state.view.to - state.view.from || 1)) * (tl?.width || 1);
const xToT = (x: number) => state.view.from + (x / (tl?.width || 1)) * (state.view.to - state.view.from);

function drawTimeline() {
  if (!tl || !ctx) return;
  const r = dpr();
  const W = Math.round(tl.clientWidth * r);
  const H = Math.round(tl.clientHeight * r);
  if (tl.width !== W || tl.height !== H) {
    tl.width = W;
    tl.height = H;
  }
  ctx.clearRect(0, 0, W, H);
  if (!state.duration) return;

  const { from, to } = state.view;
  const span = to - from;
  // Ruler ticks
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = steps.find((s) => (s / span) * W >= 80 * r) || 3600;
  ctx.font = `${11 * r}px system-ui`;
  ctx.fillStyle = '#8a929e';
  ctx.strokeStyle = '#333a44';
  ctx.lineWidth = 1;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const x = Math.round(tToX(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 8 * r);
    ctx.stroke();
    ctx.fillText(S.fmtShort(t).replace(/\.00$/, ''), x + 3 * r, 11 * r);
  }

  // Cues visualization
  const cy = 36 * r;
  const ch = 30 * r;
  ctx.font = `${11 * r}px system-ui`;
  for (const c of state.cues) {
    if (c.end < from || c.start > to) continue;
    const x0 = tToX(c.start);
    const x1 = tToX(c.end);
    ctx.fillStyle = '#2f5d8f';
    ctx.fillRect(x0, cy, Math.max(1, x1 - x0 - 1), ch);
    if (x1 - x0 > 24 * r) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, cy, x1 - x0 - 2, ch);
      ctx.clip();
      ctx.fillStyle = '#e6e8eb';
      ctx.fillText(c.text.replace(/\n/g, ' '), x0 + 3 * r, cy + 18 * r);
      ctx.restore();
    }
  }

  // Selection
  const sx = tToX(state.sel.start);
  const ex = tToX(state.sel.end);
  ctx.fillStyle = 'rgba(255,210,63,0.16)';
  ctx.fillRect(sx, 14 * r, ex - sx, H - 14 * r);
  ctx.fillStyle = '#ffd23f';
  for (const x of [sx, ex]) {
    ctx.fillRect(x - 1.5 * r, 14 * r, 3 * r, H - 14 * r);
    ctx.fillRect(x - 5 * r, H - 14 * r, 10 * r, 14 * r);
  }

  // Playhead
  const px = tToX(video ? video.currentTime : state.currentTime);
  ctx.fillStyle = '#ff6b6b';
  ctx.fillRect(px - r, 0, 2 * r, H);
}

let drag: { kind: 'start' | 'end' | 'new'; anchor?: number; x0?: number } | null = null;

function setupTimelineCanvas(canvas: HTMLCanvasElement) {
  tl = canvas;
  ctx = canvas.getContext('2d');

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.duration || !tl) return;
    tl.setPointerCapture(e.pointerId);
    const x = e.offsetX * dpr();
    const t = clamp(xToT(x), 0, state.duration);
    const near = (tt: number) => Math.abs(tToX(tt) - x) < 8 * dpr();
    if (near(state.sel.start)) drag = { kind: 'start' };
    else if (near(state.sel.end)) drag = { kind: 'end' };
    else {
      drag = { kind: 'new', anchor: t, x0: x };
      if (video) video.currentTime = t;
    }
    if (drag.kind !== 'new' && video) video.pause();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!tl) return;
    const x = e.offsetX * dpr();
    const t = clamp(xToT(x), 0, state.duration);
    if (!drag) {
      const near = (tt: number) => Math.abs(tToX(tt) - x) < 8 * dpr();
      tl.style.cursor = state.duration && (near(state.sel.start) || near(state.sel.end)) ? 'ew-resize' : 'crosshair';
      return;
    }
    if (drag.kind === 'start') {
      setSel(Math.min(t, state.sel.end - 0.05), state.sel.end);
      if (video) video.currentTime = state.sel.start;
    } else if (drag.kind === 'end') {
      setSel(state.sel.start, Math.max(t, state.sel.start + 0.05));
      if (video) video.currentTime = state.sel.end;
    } else if (drag.anchor !== undefined && drag.x0 !== undefined && Math.abs(x - drag.x0) > 4 * dpr()) {
      setSel(drag.anchor, t);
      if (video) video.currentTime = t;
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (drag) {
      drag = null;
      update();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!state.duration || !tl) return;
      e.preventDefault();
      const { from, to } = state.view;
      let span = to - from;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / tl.clientWidth) * span;
        const nf = clamp(from + d, 0, state.duration - span);
        state.view = { from: nf, to: nf + span };
        drawTimeline();
        return;
      }
      const t = xToT(e.offsetX * dpr());
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      span = clamp(span * k, 0.5, state.duration);
      let nf = t - (t - from) * (span / (to - from));
      nf = clamp(nf, 0, state.duration - span);
      state.view = { from: nf, to: nf + span };
      drawTimeline();
    },
    { passive: false }
  );

  drawTimeline();
}

function toggleZoom() {
  const whole = state.view.from === 0 && state.view.to === state.duration;
  if (whole) {
    const pad = Math.max(0.5, (state.sel.end - state.sel.start) * 0.15);
    state.view = { from: Math.max(0, state.sel.start - pad), to: Math.min(state.duration, state.sel.end + pad) };
  } else {
    state.view = { from: 0, to: state.duration };
  }
  drawTimeline();
}

/* ───────────────────────── Video Element Setup ───────────────────────── */
function setupVideoElement(el: HTMLVideoElement) {
  video = el;
  el.addEventListener('timeupdate', () => {
    state.currentTime = el.currentTime;
    if (state.loopSel && (el.currentTime < state.sel.start || el.currentTime >= state.sel.end)) {
      el.currentTime = state.sel.start;
      el.play().catch(() => {});
    }
    drawTimeline();
    update();
  });
  el.addEventListener('play', () => {
    state.isPlaying = true;
    update();
  });
  el.addEventListener('pause', () => {
    state.isPlaying = false;
    update();
  });
}

/* ───────────────────────── Cue Operations ───────────────────────── */
function addCueAtPlayhead() {
  const t = video ? video.currentTime : state.currentTime;
  const next = state.cues.find((c) => c.start > t);
  const cue: S.Cue = {
    start: t,
    end: Math.min(state.duration || t + 2, next ? next.start : t + 2, t + 2),
    text: '',
  };
  if (cue.end - cue.start < 0.2) cue.end = t + 0.5;
  state.cues.push(cue);
  setCues(state.cues);
}

function updateCueTime(index: number, field: 'start' | 'end', val: string | number) {
  const c = state.cues[index];
  if (!c) return;
  const v = typeof val === 'number' ? val : S.parseTime(val);
  if (isNaN(v)) return;
  if (field === 'start') c.start = v;
  else c.end = v;
  if (c.end < c.start) [c.start, c.end] = [c.end, c.start];
  setCues(state.cues);
}

function mergeWithNextCue(index: number) {
  const c = state.cues[index];
  const next = state.cues[index + 1];
  if (!c || !next) return;
  c.text = `${c.text.trim()} ${next.text.trim()}`;
  c.end = next.end;
  state.cues.splice(index + 1, 1);
  setCues(state.cues);
}

function deleteCue(index: number) {
  state.cues.splice(index, 1);
  setCues(state.cues);
}

function shiftAllCues() {
  const ans = prompt('Shift all subtitle timestamps by (+/- seconds, e.g. 1.5 or -0.5):', '1.0');
  if (!ans) return;
  const dt = parseFloat(ans);
  if (isNaN(dt) || dt === 0) return;
  for (const c of state.cues) {
    c.start = Math.max(0, c.start + dt);
    c.end = Math.max(0, c.end + dt);
  }
  setCues(state.cues);
}

/* ───────────────────────── Subtitle History ───────────────────────── */
const HIST_KEY = 'vibe_gif_sub_history_v1';
let autoSnapTimer: any = null;

function loadHistoryList(): HistoryAttempt[] {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistoryList(list: HistoryAttempt[]) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 100)));
  } catch (e) {
    console.warn('Failed to save subtitle history:', e);
  }
}

state.historyList = loadHistoryList();

function scheduleAutoSnapshot() {
  clearTimeout(autoSnapTimer);
  autoSnapTimer = setTimeout(() => {
    snapshotAttempt('auto-edit', true);
  }, 3500);
}

function snapshotAttempt(sourceLabel = 'manual', silent = false) {
  if (!state.cues || state.cues.length === 0) {
    if (!silent) alert('No subtitles to save in history.');
    return;
  }
  const preview = state.cues.slice(0, 3).map((c) => c.text.replace(/\n/g, ' ')).join(' / ').slice(0, 140);
  const item: HistoryAttempt = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    videoTitle: state.title || state.srcName || 'Untitled Video',
    sourceLabel,
    cueCount: state.cues.length,
    previewText: preview,
    cues: JSON.parse(JSON.stringify(state.cues)),
    sel: { ...state.sel },
  };

  const list = loadHistoryList();
  if (list.length > 0 && list[0].sourceLabel === 'auto-edit' && sourceLabel === 'auto-edit' && Date.now() - list[0].timestamp < 60000) {
    list[0] = item;
  } else {
    list.unshift(item);
  }
  state.historyList = list;
  saveHistoryList(list);
  if (!silent) {
    setStatus(`Saved attempt (${item.cueCount} cues) to history`);
    update();
  }
}

function restoreAttempt(id: string) {
  const item = state.historyList.find((h) => h.id === id);
  if (!item) return;
  if (state.cues.length) snapshotAttempt('pre-switch', true);
  setCues(JSON.parse(JSON.stringify(item.cues)), true);
  if (item.sel && item.sel.end > item.sel.start) setSel(item.sel.start, item.sel.end);
  state.historyOpen = false;
  setStatus(`Restored subtitle attempt from ${new Date(item.timestamp).toLocaleTimeString()}`);
  update();
}

function deleteAttempt(id: string) {
  state.historyList = state.historyList.filter((h) => h.id !== id);
  saveHistoryList(state.historyList);
  update();
}

function clearAllHistory() {
  if (!confirm('Clear all subtitle history attempts?')) return;
  state.historyList = [];
  saveHistoryList([]);
  update();
}

function exportHistorySRT(id: string) {
  const item = state.historyList.find((h) => h.id === id);
  if (!item) return;
  const srt = S.toSRT(item.cues);
  const blob = new Blob([srt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(item.videoTitle || 'subtitles')}_attempt_${new Date(item.timestamp).toISOString().slice(0, 10)}.srt`;
  a.click();
}

/* ───────────────────────── Rendering & Export ───────────────────────── */
function forceStyle(): string {
  const colorBgr = (hex: string) => {
    const c = hex.replace('#', '');
    return c.length === 6 ? `&H00${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}&` : '&H00FFFFFF&';
  };
  return [
    'FontName=ClipSub',
    `FontSize=${state.stSize}`,
    `PrimaryColour=${colorBgr(state.stColor)}`,
    'OutlineColour=&H00000000&',
    'BackColour=&H80000000&',
    'BorderStyle=1',
    `Outline=${state.stOutline}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${state.stMargin}`,
  ].join(',');
}

async function render() {
  const { start, end } = state.sel;
  const dur = end - start;
  if (!state.srcBytes) return;
  if (dur < 0.1) return alert('Select a range on the timeline first.');

  const want = {
    mp4: state.outMp4,
    webp: state.outWebp,
    gif: state.outGif,
    srt: state.outSrt,
  };
  if (!Object.values(want).some(Boolean)) return alert('Pick at least one output format.');

  const name = slug(state.outName || state.title);
  const width = state.outWidth;
  const fps = state.outFps;
  const q = state.outQuality;
  const srt = S.toSRT(state.cues, start, dur);

  setBusy(true);
  try {
    if (want.srt) {
      addResultItem(`${name}.srt`, 'srt', new Blob([srt], { type: 'text/plain' }), srt);
    }
    if (!(want.mp4 || want.webp || want.gif)) return;

    const f = await getFF();
    const src = await ensureSourceInFS();
    const hasSubs = srt.trim().length > 0;
    if (hasSubs) await f.writeFile('/work/subs.srt', new TextEncoder().encode(srt));

    const sub = hasSubs ? `subtitles=/work/subs.srt:fontsdir=/fonts:force_style='${forceStyle()}'` : '';
    const scale = width ? `scale=${width}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    const chain = (...xs: string[]) => xs.filter(Boolean).join(',');
    const input = ['-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
    const jobs: Array<{ ext: string; label: string; mime: string; args: string[] }> = [];

    if (want.mp4) {
      jobs.push({
        ext: 'mp4',
        label: 'Encoding MP4',
        mime: 'video/mp4',
        args: [
          ...input,
          '-vf',
          chain(scale, sub),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          ...(state.outAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
          '-movflags',
          '+faststart',
        ],
      });
    }
    if (want.webp) {
      jobs.push({
        ext: 'webp',
        label: 'Encoding WebP',
        mime: 'image/webp',
        args: [
          ...input,
          '-vf',
          chain(`fps=${fps}`, scale, sub),
          '-c:v',
          'libwebp',
          '-quality',
          String(q),
          '-compression_level',
          '4',
          '-loop',
          '0',
          '-an',
        ],
      });
    }
    if (want.gif) {
      jobs.push({
        ext: 'gif',
        label: 'Encoding GIF',
        mime: 'image/gif',
        args: [
          ...input,
          '-filter_complex',
          `${chain(`fps=${fps}`, scale, sub)},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
          '-loop',
          '0',
          '-an',
        ],
      });
    }

    for (const job of jobs) {
      const out = `/work/out.${job.ext}`;
      const t0 = performance.now();
      await run([...job.args, out], job.label, dur);
      const data = (await f.readFile(out)) as Uint8Array;
      await f.deleteFile(out);
      addResultItem(`${name}.${job.ext}`, job.ext, new Blob([data as any], { type: job.mime }));
      log(`→ ${name}.${job.ext} ${fmtBytes(data.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }
    setStatus(`Rendered ${jobs.map((j) => j.ext.toUpperCase()).join(', ')}`);
  } catch (e: any) {
    if (state.busy && ff) console.error(e);
    setStatus(`Error: ${e.message}`);
    alert(`Render failed: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

function addResultItem(name: string, ext: string, blob: Blob, text?: string) {
  const item: RenderResultItem = {
    id: `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    ext,
    blob,
    url: URL.createObjectURL(blob),
    text,
    size: blob.size,
  };
  state.results.unshift(item);
  update();
}

async function saveResultNative(item: RenderResultItem) {
  try {
    const res = await fetch(`/api/save?name=${encodeURIComponent(item.name)}`, {
      method: 'POST',
      body: item.blob,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    item.saved = true;
    item.savePath = out.path;
    setStatus(`Saved to ${out.path}`);
    update();
  } catch (e: any) {
    alert(`Save failed: ${e.message}`);
    setStatus(`Save failed: ${e.message}`);
  }
}

/* ───────────────────────── Files & Drag/Drop ───────────────────────── */
async function openFiles(files: File[]) {
  for (const file of files) {
    if (/\.(srt|vtt|json3?)$/i.test(file.name)) {
      if (state.cues.length && !confirm(`Replace current subtitles with ${file.name}?`)) continue;
      setCues(S.parseSubtitles(await file.text(), file.name.endsWith('json3') ? 'json3' : ''));
      setStatus(`Loaded ${state.cues.length} cues from ${file.name}`);
    } else if (file.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(file.name)) {
      setCaptionTracks([]);
      setBusy(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await setSource(bytes, file.name, file.name);
      } finally {
        setBusy(false);
      }
    }
  }
}

/* ───────────────────────── Global Event Listeners ───────────────────────── */
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    dragDepth++;
    document.body.classList.add('dragging');
  }
});
document.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) return openFiles(Array.from(e.dataTransfer.files));
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
  if (text && /^https?:\/\//.test(text.trim())) {
    state.urlInput = text.trim();
    loadUrl(state.urlInput);
  }
});

document.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement)?.closest('input, textarea')) return;
  const text = e.clipboardData?.getData('text');
  if (text && /^https?:\/\//.test(text.trim())) {
    state.urlInput = text.trim();
    loadUrl(state.urlInput);
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.closest('input, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (video) (video.paused ? video.play() : video.pause());
  } else if (e.key === 'l' || e.key === 'L') {
    state.loopSel = !state.loopSel;
    if (state.loopSel && video) {
      video.currentTime = state.sel.start;
      video.play().catch(() => {});
    }
    update();
  } else if (e.key === 'i' || e.key === 'I') {
    if (video) setSel(video.currentTime, Math.max(video.currentTime + 0.1, state.sel.end));
  } else if (e.key === 'o' || e.key === 'O') {
    if (video) setSel(Math.min(state.sel.start, video.currentTime - 0.1), video.currentTime);
  } else if (e.key === 'z' || e.key === 'Z') {
    toggleZoom();
  } else if (e.key === 'a' || e.key === 'A') {
    addCueAtPlayhead();
  } else if (e.key === 'ArrowLeft' && video) {
    video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 1 / 30));
  } else if (e.key === 'ArrowRight' && video) {
    video.currentTime = Math.min(state.duration, video.currentTime + (e.shiftKey ? 1 : 1 / 30));
  }
});

/* ───────────────────────── Shared YouTube URL Reception (Android / Web) ───────────────────────── */
let lastHandledSharedUrl: string | null = null;

function handleIncomingSharedUrl(rawUrl: string) {
  if (typeof rawUrl !== 'string') return;
  const url = rawUrl.trim();
  if (!url) return;
  if (url === lastHandledSharedUrl) {
    console.log('[SharedUrl] Already handled recently:', url);
    return;
  }
  lastHandledSharedUrl = url;
  console.log('[SharedUrl] Handling incoming URL:', url);

  state.urlInput = url;
  update(); // Instantly reflect the URL in the input box!

  if (state.busy) {
    state.abort?.abort();
    if (progressCtx || ffLoading) killFF();
    setBusy(false);
  }
  loadUrl(url);

  try {
    const bridge = (window as any)._AndroidShare;
    if (bridge && typeof bridge.clearPendingUrl === 'function') {
      bridge.clearPendingUrl();
    }
  } catch (e) {
    // Ignore
  }
}

// Drain any early URLs buffered in window._pendingSharedUrls
const pendingEarlyUrls = Array.isArray((window as any)._pendingSharedUrls) ? (window as any)._pendingSharedUrls.slice() : [];
(window as any)._pendingSharedUrls = [];
(window as any).onSharedUrl = handleIncomingSharedUrl;
for (const earlyUrl of pendingEarlyUrls) {
  handleIncomingSharedUrl(earlyUrl);
}

// Poll native Android bridge on startup (in case bridge is injected slightly after page eval)
let bridgeCheckCount = 0;
const bridgeCheckInterval = setInterval(() => {
  bridgeCheckCount++;
  try {
    const bridge = (window as any)._AndroidShare;
    if (bridge && typeof bridge.getPendingUrl === 'function') {
      const nativePending = bridge.getPendingUrl();
      if (nativePending && typeof nativePending === 'string' && nativePending.trim()) {
        console.log('[AndroidShareBridge] Found pending URL:', nativePending);
        handleIncomingSharedUrl(nativePending);
        clearInterval(bridgeCheckInterval);
        return;
      }
    }
  } catch (e) {
    console.warn('Could not read Android pending URL:', e);
  }
  if (bridgeCheckCount > 50) {
    clearInterval(bridgeCheckInterval);
  }
}, 100);

/* ───────────────────────── TSX Component Views ───────────────────────── */
function renderApp(): VNode {
  const curTime = video ? video.currentTime : state.currentTime;
  const activeCues = state.cues.filter((c) => curTime >= c.start && curTime <= c.end);
  const overlayText = activeCues.map((c) => c.text).join('\n');

  const filteredHistory = state.historySearch
    ? state.historyList.filter(
        (h) =>
          h.videoTitle.toLowerCase().includes(state.historySearch.toLowerCase()) ||
          h.previewText.toLowerCase().includes(state.historySearch.toLowerCase())
      )
    : state.historyList;

  return (
    <div id="app" class="app-root">
      {/* ── Header ── */}
      <header>
        <h1>✂ Clip Editor</h1>
        <form
          id="url-form"
          onSubmit={(e: Event) => {
            e.preventDefault();
            loadUrl(state.urlInput);
          }}
        >
          <input
            id="url"
            type="url"
            placeholder="Paste a YouTube or direct video URL…"
            autocomplete="off"
            required
            value={state.urlInput}
            onInput={(e: any) => {
              state.urlInput = e.target.value;
            }}
          />
          <button type="submit" class="primary" disabled={state.busy}>
            Load
          </button>
        </form>

        <label class="btn">
          Open file…
          <input
            id="file"
            type="file"
            accept="video/*,.srt,.vtt,.json3"
            multiple
            hidden
            onChange={(e: any) => {
              openFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
        </label>

        <button
          id="btn-history"
          type="button"
          class="btn"
          title="View past subtitle attempts"
          onClick={() => {
            state.historyOpen = true;
            update();
          }}
        >
          📜 History (<span id="hist-count">{state.historyList.length}</span>)
        </button>

        <span id="status" class="status" title={state.status}>
          {state.status}
        </span>
      </header>

      {/* ── Main Workspace ── */}
      <main>
        {/* Left Side: Video, Transport, Styling, Export, Log */}
        <section class="left">
          <div id="stage" class={{ stage: true, empty: !state.srcBytes }}>
            <video
              key="main-player-video"
              id="video"
              playsinline
              preload="auto"
              hook={{
                insert: (vn) => setupVideoElement(vn.elm as HTMLVideoElement),
              }}
            />
            <div
              id="overlay"
              class="overlay"
              style={{
                fontSize: `${state.stSize}px`,
                bottom: `${state.stMargin}px`,
                color: state.stColor,
                textShadow: `-${state.stOutline}px -${state.stOutline}px 0 #000, ${state.stOutline}px -${state.stOutline}px 0 #000, -${state.stOutline}px ${state.stOutline}px 0 #000, ${state.stOutline}px ${state.stOutline}px 0 #000`,
              }}
            >
              {overlayText}
            </div>

            <div class="placeholder">Paste a URL, open a file, or drop a video / .srt / .vtt anywhere</div>

            <div id="progress-wrap" class="progress-wrap" hidden={!state.progressVisible}>
              <div
                id="progress-bar"
                style={{
                  width: state.progressFrac == null ? '100%' : `${(state.progressFrac * 100).toFixed(1)}%`,
                  opacity: state.progressFrac == null ? '0.35' : '1',
                }}
              />
              <span id="progress-text">{state.progressText}</span>
            </div>
          </div>

          <h2 id="title" class="title">
            {state.title}
          </h2>

          <div class="transport">
            <button
              id="play"
              title="Play / pause (Space)"
              onClick={() => {
                if (video) (video.paused ? video.play() : video.pause());
              }}
            >
              {state.isPlaying ? '⏸' : '▶'}
            </button>
            <button
              id="play-sel"
              class={{ primary: state.loopSel }}
              title="Loop the selection (L)"
              onClick={() => {
                state.loopSel = !state.loopSel;
                if (state.loopSel && video) {
                  video.currentTime = state.sel.start;
                  video.play().catch(() => {});
                }
                update();
              }}
            >
              ⟳ Selection
            </button>
            <span class="time" id="cur">
              {S.fmtShort(curTime)}
            </span>{' '}
            / <span class="time" id="dur">{S.fmtShort(state.duration)}</span>
            <span class="spacer" />
            <label>
              In{' '}
              <input
                id="sel-start"
                class="t"
                value={S.fmtShort(state.sel.start)}
                onChange={(e: any) => {
                  const v = S.parseTime(e.target.value);
                  if (!isNaN(v)) {
                    setSel(v, state.sel.end);
                    if (video) video.currentTime = state.sel.start;
                  }
                }}
              />
            </label>
            <button
              id="set-start"
              title="Set in-point to playhead (I)"
              onClick={() => {
                if (video) setSel(video.currentTime, Math.max(video.currentTime + 0.1, state.sel.end));
              }}
            >
              [ I
            </button>
            <label>
              Out{' '}
              <input
                id="sel-end"
                class="t"
                value={S.fmtShort(state.sel.end)}
                onChange={(e: any) => {
                  const v = S.parseTime(e.target.value);
                  if (!isNaN(v)) {
                    setSel(state.sel.start, v);
                    if (video) video.currentTime = state.sel.end;
                  }
                }}
              />
            </label>
            <button
              id="set-end"
              title="Set out-point to playhead (O)"
              onClick={() => {
                if (video) setSel(Math.min(state.sel.start, video.currentTime - 0.1), video.currentTime);
              }}
            >
              O ]
            </button>
            <span class="time dim" id="sel-len">
              ({(state.sel.end - state.sel.start).toFixed(2)}s)
            </span>
            <button id="fit" title="Zoom timeline: whole video / selection (Z)" onClick={toggleZoom}>
              Zoom
            </button>
          </div>

          <canvas
            key="timeline-canvas"
            id="timeline"
            class="timeline"
            height={96}
            hook={{
              insert: (vn) => setupTimelineCanvas(vn.elm as HTMLCanvasElement),
            }}
          />
          <p class="hint">
            Drag on the timeline to select · drag the yellow handles · scroll to zoom · ←/→ step 1 frame (Shift: 1s) · I / O set in/out
          </p>

          <details class="panel" open>
            <summary>Subtitle style</summary>
            <div class="grid">
              <label>
                Size{' '}
                <input
                  id="st-size"
                  type="range"
                  min="10"
                  max="40"
                  value={state.stSize}
                  onInput={(e: any) => {
                    state.stSize = +e.target.value;
                    update();
                  }}
                />
                <output>{state.stSize}px</output>
              </label>
              <label>
                Outline{' '}
                <input
                  id="st-outline"
                  type="range"
                  min="0"
                  max="5"
                  step="0.5"
                  value={state.stOutline}
                  onInput={(e: any) => {
                    state.stOutline = +e.target.value;
                    update();
                  }}
                />
                <output>{state.stOutline}px</output>
              </label>
              <label>
                Bottom margin{' '}
                <input
                  id="st-margin"
                  type="range"
                  min="0"
                  max="80"
                  value={state.stMargin}
                  onInput={(e: any) => {
                    state.stMargin = +e.target.value;
                    update();
                  }}
                />
                <output>{state.stMargin}px</output>
              </label>
              <label>
                Colour{' '}
                <input
                  id="st-color"
                  type="color"
                  value={state.stColor}
                  onInput={(e: any) => {
                    state.stColor = e.target.value;
                    update();
                  }}
                />
              </label>
            </div>
          </details>

          <details class="panel" open>
            <summary>Export</summary>
            <div class="grid">
              <label>
                <input
                  type="checkbox"
                  id="out-mp4"
                  checked={state.outMp4}
                  onChange={(e: any) => {
                    state.outMp4 = e.target.checked;
                    update();
                  }}
                />{' '}
                MP4
              </label>
              <label>
                <input
                  type="checkbox"
                  id="out-audio"
                  checked={state.outAudio}
                  onChange={(e: any) => {
                    state.outAudio = e.target.checked;
                    update();
                  }}
                />{' '}
                with audio
              </label>
              <label>
                <input
                  type="checkbox"
                  id="out-webp"
                  checked={state.outWebp}
                  onChange={(e: any) => {
                    state.outWebp = e.target.checked;
                    update();
                  }}
                />{' '}
                Animated WebP
              </label>
              <label>
                <input
                  type="checkbox"
                  id="out-gif"
                  checked={state.outGif}
                  onChange={(e: any) => {
                    state.outGif = e.target.checked;
                    update();
                  }}
                />{' '}
                GIF
              </label>
              <label>
                <input
                  type="checkbox"
                  id="out-srt"
                  checked={state.outSrt}
                  onChange={(e: any) => {
                    state.outSrt = e.target.checked;
                    update();
                  }}
                />{' '}
                .srt
              </label>
              <label>
                Width
                <select
                  id="out-width"
                  value={state.outWidth}
                  onChange={(e: any) => {
                    state.outWidth = +e.target.value;
                    update();
                  }}
                >
                  <option value="320">320</option>
                  <option value="480">480</option>
                  <option value="640">640</option>
                  <option value="720">720</option>
                  <option value="0">source</option>
                </select>
              </label>
              <label>
                FPS (WebP/GIF)
                <select
                  id="out-fps"
                  value={state.outFps}
                  onChange={(e: any) => {
                    state.outFps = +e.target.value;
                    update();
                  }}
                >
                  <option value="10">10</option>
                  <option value="12">12</option>
                  <option value="15">15</option>
                  <option value="24">24</option>
                </select>
              </label>
              <label>
                WebP quality{' '}
                <input
                  id="out-q"
                  type="range"
                  min="30"
                  max="95"
                  value={state.outQuality}
                  onInput={(e: any) => {
                    state.outQuality = +e.target.value;
                    update();
                  }}
                />
                <output>{state.outQuality}</output>
              </label>
            </div>
            <div class="row">
              <input
                id="out-name"
                placeholder="file name"
                class="grow"
                value={state.outName}
                onInput={(e: any) => {
                  state.outName = e.target.value;
                }}
              />
              <button id="render" class="primary" disabled={state.busy || !state.srcBytes} onClick={render}>
                Render
              </button>
              <button
                id="cancel"
                hidden={!state.busy}
                onClick={() => {
                  state.abort?.abort();
                  if (progressCtx || ffLoading) killFF();
                  setBusy(false);
                  setStatus('Cancelled');
                }}
              >
                Cancel
              </button>
            </div>
            <div id="results" class="results">
              {state.results.map((res) => (
                <div key={res.id} class="result">
                  {res.ext === 'mp4' ? (
                    <video src={res.url} controls loop muted autoplay playsinline />
                  ) : res.ext === 'srt' ? (
                    <pre>{res.text || '(no cues in selection)'}</pre>
                  ) : (
                    <img src={res.url} alt={res.name} />
                  )}
                  <div class="meta">
                    {NATIVE ? (
                      <button
                        type="button"
                        class="primary"
                        disabled={res.saved}
                        onClick={() => saveResultNative(res)}
                      >
                        {res.saved ? '✓ Saved' : `💾 Save ${res.name}`}
                      </button>
                    ) : (
                      <a href={res.url} download={res.name}>
                        ⬇ {res.name}
                      </a>
                    )}
                    <span class="dim">{fmtBytes(res.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          </details>

          <details class="panel">
            <summary>ffmpeg log</summary>
            <pre id="log" />
          </details>
        </section>

        {/* Right Side: Subtitles Cue List & Controls */}
        <section class="right">
          <div class="subs-head">
            <h2>
              Subtitles <span id="cue-count" class="dim">({state.cues.length})</span>
            </h2>
            <div class="row">
              <select
                id="tracks"
                class="grow"
                value={state.selectedTrack}
                onChange={(e: any) => {
                  state.selectedTrack = +e.target.value;
                  update();
                }}
              >
                {state.captions.length ? (
                  state.captions.map((c, i) => (
                    <option key={`track-${i}`} value={i}>
                      {c.name} [{c.lang}]
                    </option>
                  ))
                ) : (
                  <option value="">— no caption tracks —</option>
                )}
              </select>
              <button id="load-track" disabled={!state.captions.length} onClick={() => loadTrack(state.selectedTrack)}>
                Load
              </button>
            </div>
            <div class="row wrap">
              <button id="add-cue" title="Add a cue at the playhead (A)" onClick={addCueAtPlayhead}>
                + Add
              </button>
              <button
                id="group"
                title="Merge short neighbouring cues into readable chunks"
                onClick={() => setCues(S.autoGroup(state.cues))}
              >
                Group lines
              </button>
              <button
                id="tidy"
                title="Capitalise sentence starts and 'I'"
                onClick={() => setCues(S.tidyCase(state.cues))}
              >
                Aa Tidy
              </button>
              <button id="shift" title="Shift every cue by N seconds" onClick={shiftAllCues}>
                Shift…
              </button>
              <button
                id="clear-cues"
                title="Remove all cues"
                onClick={() => {
                  if (confirm('Remove all subtitles?')) setCues([]);
                }}
              >
                Clear
              </button>
              <button
                id="btn-snap"
                title="Save snapshot of current subtitles to history"
                onClick={() => snapshotAttempt('manual', false)}
              >
                💾 Save Attempt
              </button>
              <label class="small">
                <input
                  type="checkbox"
                  id="only-sel"
                  checked={state.onlySel}
                  onChange={(e: any) => {
                    state.onlySel = e.target.checked;
                    update();
                  }}
                />{' '}
                only selection
              </label>
            </div>
          </div>

          <div id="cues" class="cues">
            {state.cues.length === 0 ? (
              <div class="empty-note">No subtitles loaded. Click "+ Add" or drop an .srt / .vtt file.</div>
            ) : (
              state.cues.map((c, i) => {
                const active = curTime >= c.start && curTime <= c.end;
                const outside = state.onlySel && (c.end < state.sel.start || c.start > state.sel.end);
                return (
                  <div key={`cue-${i}`} class={{ cue: true, active, outside }}>
                    <div class="cue-times">
                      <button
                        class="seek"
                        title="Seek here"
                        onClick={() => {
                          if (video) video.currentTime = c.start + 0.001;
                        }}
                      >
                        ▶
                      </button>
                      <input
                        class="t c-start"
                        value={S.fmtShort(c.start)}
                        onChange={(e: any) => updateCueTime(i, 'start', e.target.value)}
                      />
                      <button
                        class="now-start"
                        title="Start = playhead"
                        onClick={() => updateCueTime(i, 'start', curTime)}
                      >
                        ⏱
                      </button>
                      <input
                        class="t c-end"
                        value={S.fmtShort(c.end)}
                        onChange={(e: any) => updateCueTime(i, 'end', e.target.value)}
                      />
                      <button
                        class="now-end"
                        title="End = playhead"
                        onClick={() => updateCueTime(i, 'end', curTime)}
                      >
                        ⏱
                      </button>
                      <span class="spacer" />
                      <button class="merge" title="Merge with next cue" onClick={() => mergeWithNextCue(i)}>
                        ⇣
                      </button>
                      <button class="del" title="Delete cue" onClick={() => deleteCue(i)}>
                        ✕
                      </button>
                    </div>
                    <textarea
                      class="c-text"
                      rows={2}
                      spellcheck={true}
                      value={c.text}
                      onInput={(e: any) => {
                        c.text = e.target.value;
                        scheduleAutoSnapshot();
                        update();
                      }}
                    />
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>

      {/* ── Subtitle History Modal ── */}
      {state.historyOpen ? (
        <dialog
          id="history-dialog"
          class="history-dialog"
          open
          hook={{
            insert: (vn) => {
              const d = vn.elm as HTMLDialogElement;
              if (typeof d.showModal === 'function' && !d.open) d.showModal();
            },
          }}
          onClick={(e: MouseEvent) => {
            if ((e.target as HTMLElement).id === 'history-dialog') {
              state.historyOpen = false;
              update();
            }
          }}
        >
          <div class="history-box">
            <div class="history-header">
              <div class="row">
                <h2>📜 Subtitle History</h2>
                <span class="spacer" />
                <button
                  id="hist-save-now"
                  class="primary"
                  title="Snapshot current subtitles"
                  onClick={() => snapshotAttempt('manual', false)}
                >
                  + Snapshot Current
                </button>
                <button id="hist-clear" class="btn" title="Clear all subtitle history" onClick={clearAllHistory}>
                  Clear All
                </button>
                <button
                  id="hist-close"
                  class="btn"
                  title="Close dialog"
                  onClick={() => {
                    state.historyOpen = false;
                    update();
                  }}
                >
                  ✕
                </button>
              </div>
              <p class="hint">
                Switch back to any previous subtitling attempt at any time. Video is not duplicated; only subtitle changes,
                timings, and selection are preserved.
              </p>
              <div class="row">
                <input
                  id="hist-search"
                  type="search"
                  placeholder="Search by video title or subtitle text…"
                  class="grow"
                  value={state.historySearch}
                  onInput={(e: any) => {
                    state.historySearch = e.target.value;
                    update();
                  }}
                />
              </div>
            </div>
            <div id="hist-list" class="history-list">
              {filteredHistory.length === 0 ? (
                <div class="empty-note">No matching subtitle history.</div>
              ) : (
                filteredHistory.map((item) => {
                  const d = new Date(item.timestamp);
                  const dateStr =
                    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
                    ' ' +
                    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={item.id} class="hist-card">
                      <div class="hist-top">
                        <span class="hist-title" title={item.videoTitle}>
                          {item.videoTitle}
                        </span>
                        <span class="hist-date">{dateStr}</span>
                      </div>
                      <div class="hist-meta">
                        <span class="badge">{item.cueCount} cues</span>
                        {item.sel && item.sel.end > item.sel.start ? (
                          <span class="badge">
                            Range: {S.fmtShort(item.sel.start)} – {S.fmtShort(item.sel.end)}
                          </span>
                        ) : null}
                        <span class="dim">Tag: {item.sourceLabel || 'snapshot'}</span>
                      </div>
                      <div class="hist-preview">{item.previewText || '(empty cues)'}</div>
                      <div class="hist-actions">
                        <button class="primary act-switch" type="button" onClick={() => restoreAttempt(item.id)}>
                          ↻ Switch to this attempt
                        </button>
                        <button class="btn act-export" type="button" onClick={() => exportHistorySRT(item.id)}>
                          ⬇ .srt
                        </button>
                        <button class="btn del act-del" type="button" onClick={() => deleteAttempt(item.id)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}

// Initial mount
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => update());
} else {
  update();
}
