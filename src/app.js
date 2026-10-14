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
import { jsx } from './jsx.js';
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
const state = {
    title: '',
    duration: 0,
    srcBytes: null,
    srcName: '',
    srcInFS: false,
    cues: [],
    sel: { start: 0, end: 0 },
    view: { from: 0, to: 0 },
    captions: [],
    loopSel: false,
    busy: false,
    abort: null,
    pendingStart: null,
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
    progressFrac: null,
    progressText: '',
    // Results
    results: [],
    // History dialog
    historyOpen: false,
    historySearch: '',
    historyList: [],
    currentTime: 0,
    isPlaying: false,
};
/* ───────────────────────── DOM / Media References ───────────────────────── */
let video = null;
let tl = null;
let ctx = null;
let rootVNode = null;
let isUpdating = false;
function update() {
    if (isUpdating)
        return;
    isUpdating = true;
    requestAnimationFrame(() => {
        isUpdating = false;
        const appEl = document.getElementById('app');
        if (!appEl && !rootVNode)
            return;
        const newVNode = renderApp();
        if (!rootVNode && appEl) {
            rootVNode = patch(appEl, newVNode);
        }
        else if (rootVNode) {
            rootVNode = patch(rootVNode, newVNode);
        }
        drawTimeline();
    });
}
/* ───────────────────────── ffmpeg.wasm ───────────────────────── */
let ff = null;
let ffLoading = null;
let progressCtx = null;
function getFF() {
    if (ff)
        return Promise.resolve(ff);
    ffLoading ??= (async () => {
        setStatus('Loading ffmpeg.wasm (~31 MB, cached after first load)…');
        const f = new FFmpeg();
        f.on('log', ({ message }) => onFFLog(message));
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
    if (ff)
        ff.terminate();
    ff = null;
    ffLoading = null;
    state.srcInFS = false;
}
const logLines = [];
let logFlush = 0;
function log(msg) {
    logLines.push(msg);
    if (logLines.length > 3000)
        logLines.splice(0, 1000);
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
function onFFLog(msg) {
    log(msg);
    if (!progressCtx)
        return;
    const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
    if (m && progressCtx.dur) {
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
        showProgress(Math.min(1, t / progressCtx.dur), `${progressCtx.label} ${Math.round((100 * t) / progressCtx.dur)}%`);
    }
}
async function run(args, label, dur = 0) {
    const f = await getFF();
    progressCtx = { label, dur };
    showProgress(dur ? 0 : null, label);
    log(`\n$ ffmpeg ${args.map((a) => (/[\s,;']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    try {
        const rc = await f.exec(args);
        if (rc !== 0)
            throw new Error(`ffmpeg failed during "${label}" (exit ${rc}) — see the ffmpeg log`);
    }
    finally {
        progressCtx = null;
    }
}
async function ensureSourceInFS() {
    const f = await getFF();
    if (!state.srcInFS && state.srcBytes) {
        await f.writeFile(`/work/${state.srcName}`, state.srcBytes.slice());
        state.srcInFS = true;
    }
    return `/work/${state.srcName}`;
}
/* ───────────────────────── UI Helpers ───────────────────────── */
function setStatus(text) {
    state.status = text;
    update();
}
function showProgress(frac, text) {
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
function setBusy(busy) {
    state.busy = busy;
    if (!busy) {
        hideProgress();
        state.abort = null;
    }
    update();
}
const fmtBytes = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const slug = (s) => (s || 'clip')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50) || 'clip';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mimeFor = (name) => ({
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
}[name.split('.').pop()?.toLowerCase() || ''] || 'video/mp4');
async function api(path) {
    const res = await fetch(path, { signal: state.abort?.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}
/* ───────────────────────── Fetching & Loading Media ───────────────────────── */
async function download(url, label, sizeHint = 0) {
    const CHUNK = 8 * 1024 * 1024;
    const parts = [];
    let got = 0;
    let total = sizeHint || 0;
    const signal = state.abort?.signal;
    for (;;) {
        const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
            headers: { Range: `bytes=${got}-${got + CHUNK - 1}` },
            signal,
        });
        if (res.status === 416)
            break;
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(`${label}: ${j.error || `HTTP ${res.status}`}`);
        }
        const cr = res.headers.get('content-range');
        const m = cr && /\/(\d+)/.exec(cr);
        if (m)
            total = +m[1];
        else if (res.status === 200)
            total = +(res.headers.get('content-length') || total);
        const reader = res.body?.getReader();
        if (!reader)
            break;
        let chunkGot = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                parts.push(value);
                got += value.length;
                chunkGot += value.length;
                showProgress(total ? got / total : null, `Downloading ${label} ${fmtBytes(got)}${total ? ' / ' + fmtBytes(total) : ''}`);
            }
        }
        if (res.status === 200 || chunkGot < CHUNK || (total && got >= total))
            break;
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
async function loadUrl(raw) {
    const url = raw.trim();
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return alert('That does not look like a URL.');
    }
    if (state.busy)
        return;
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
                bytes = (await f.readFile('/work/mux.mp4'));
                await f.deleteFile('/work/in_v');
                await f.deleteFile('/work/in_a');
                await f.deleteFile('/work/mux.mp4');
            }
            await setSource(bytes, `${slug(info.title || 'video')}.mp4`, info.title || url);
            if (info.captions?.length)
                loadTrack(0, false).catch((e) => console.warn(e));
        }
        else {
            const name = decodeURIComponent(u.pathname.split('/').pop() || 'video.mp4');
            showProgress(null, `Fetching ${name}…`);
            const bytes = await download(url, name);
            await setSource(bytes, name, name);
        }
    }
    catch (e) {
        if (state.busy && ff)
            console.error(e);
        setStatus(`Error: ${e.message}`);
        alert(`Failed to load URL: ${e.message}`);
    }
    finally {
        setBusy(false);
    }
}
async function setSource(bytes, name, title, alreadyInFS = false) {
    if (ff && state.srcName && !alreadyInFS)
        await ff.deleteFile(`/work/${state.srcName}`).catch(() => { });
    state.srcBytes = bytes;
    state.srcName = name.replace(/[^\w.-]/g, '_');
    state.srcInFS = alreadyInFS && name === state.srcName;
    state.title = title || name;
    state.outName = slug(state.title);
    if (video) {
        if (video.src)
            URL.revokeObjectURL(video.src);
        video.src = URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) }));
        await new Promise((resolve) => {
            if (!video)
                return resolve();
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
    if (video)
        video.currentTime = start;
    setStatus(`Loaded ${state.srcName} (${fmtBytes(bytes.length)})`);
    update();
}
function setCaptionTracks(list) {
    state.captions = list;
    state.selectedTrack = 0;
    update();
}
async function loadTrack(i, confirmReplace = true) {
    const c = state.captions[i];
    if (!c)
        return;
    if (confirmReplace && state.cues.length && !confirm('Replace the current subtitles?'))
        return;
    setStatus(`Loading captions: ${c.name}…`);
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(c.url)}`);
    if (!res.ok)
        throw new Error(`captions: HTTP ${res.status}`);
    setCues(S.parseSubtitles(await res.text(), c.ext));
    setStatus(`Loaded ${state.cues.length} cues (${c.name})`);
}
function setCues(cues, skipAutoSnap = false) {
    state.cues = cues.slice().sort((a, b) => a.start - b.start);
    update();
    if (!skipAutoSnap)
        scheduleAutoSnapshot();
}
function setSel(start, end) {
    start = clamp(start, 0, state.duration);
    end = clamp(end, 0, state.duration);
    if (end < start)
        [start, end] = [end, start];
    state.sel = { start, end };
    update();
}
/* ───────────────────────── Timeline Drawing & Interaction ───────────────────────── */
const dpr = () => window.devicePixelRatio || 1;
const tToX = (t) => ((t - state.view.from) / (state.view.to - state.view.from || 1)) * (tl?.width || 1);
const xToT = (x) => state.view.from + (x / (tl?.width || 1)) * (state.view.to - state.view.from);
function drawTimeline() {
    if (!tl || !ctx)
        return;
    const r = dpr();
    const W = Math.round(tl.clientWidth * r);
    const H = Math.round(tl.clientHeight * r);
    if (tl.width !== W || tl.height !== H) {
        tl.width = W;
        tl.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    if (!state.duration)
        return;
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
        if (c.end < from || c.start > to)
            continue;
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
let drag = null;
function setupTimelineCanvas(canvas) {
    tl = canvas;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', (e) => {
        if (!state.duration || !tl)
            return;
        tl.setPointerCapture(e.pointerId);
        const x = e.offsetX * dpr();
        const t = clamp(xToT(x), 0, state.duration);
        const near = (tt) => Math.abs(tToX(tt) - x) < 8 * dpr();
        if (near(state.sel.start))
            drag = { kind: 'start' };
        else if (near(state.sel.end))
            drag = { kind: 'end' };
        else {
            drag = { kind: 'new', anchor: t, x0: x };
            if (video)
                video.currentTime = t;
        }
        if (drag.kind !== 'new' && video)
            video.pause();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!tl)
            return;
        const x = e.offsetX * dpr();
        const t = clamp(xToT(x), 0, state.duration);
        if (!drag) {
            const near = (tt) => Math.abs(tToX(tt) - x) < 8 * dpr();
            tl.style.cursor = state.duration && (near(state.sel.start) || near(state.sel.end)) ? 'ew-resize' : 'crosshair';
            return;
        }
        if (drag.kind === 'start') {
            setSel(Math.min(t, state.sel.end - 0.05), state.sel.end);
            if (video)
                video.currentTime = state.sel.start;
        }
        else if (drag.kind === 'end') {
            setSel(state.sel.start, Math.max(t, state.sel.start + 0.05));
            if (video)
                video.currentTime = state.sel.end;
        }
        else if (drag.anchor !== undefined && drag.x0 !== undefined && Math.abs(x - drag.x0) > 4 * dpr()) {
            setSel(drag.anchor, t);
            if (video)
                video.currentTime = t;
        }
    });
    canvas.addEventListener('pointerup', () => {
        if (drag) {
            drag = null;
            update();
        }
    });
    canvas.addEventListener('wheel', (e) => {
        if (!state.duration || !tl)
            return;
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
    }, { passive: false });
    drawTimeline();
}
function toggleZoom() {
    const whole = state.view.from === 0 && state.view.to === state.duration;
    if (whole) {
        const pad = Math.max(0.5, (state.sel.end - state.sel.start) * 0.15);
        state.view = { from: Math.max(0, state.sel.start - pad), to: Math.min(state.duration, state.sel.end + pad) };
    }
    else {
        state.view = { from: 0, to: state.duration };
    }
    drawTimeline();
}
/* ───────────────────────── Video Element Setup ───────────────────────── */
function setupVideoElement(el) {
    video = el;
    el.addEventListener('timeupdate', () => {
        state.currentTime = el.currentTime;
        if (state.loopSel && (el.currentTime < state.sel.start || el.currentTime >= state.sel.end)) {
            el.currentTime = state.sel.start;
            el.play().catch(() => { });
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
    const cue = {
        start: t,
        end: Math.min(state.duration || t + 2, next ? next.start : t + 2, t + 2),
        text: '',
    };
    if (cue.end - cue.start < 0.2)
        cue.end = t + 0.5;
    state.cues.push(cue);
    setCues(state.cues);
}
function updateCueTime(index, field, val) {
    const c = state.cues[index];
    if (!c)
        return;
    const v = typeof val === 'number' ? val : S.parseTime(val);
    if (isNaN(v))
        return;
    if (field === 'start')
        c.start = v;
    else
        c.end = v;
    if (c.end < c.start)
        [c.start, c.end] = [c.end, c.start];
    setCues(state.cues);
}
function mergeWithNextCue(index) {
    const c = state.cues[index];
    const next = state.cues[index + 1];
    if (!c || !next)
        return;
    c.text = `${c.text.trim()} ${next.text.trim()}`;
    c.end = next.end;
    state.cues.splice(index + 1, 1);
    setCues(state.cues);
}
function deleteCue(index) {
    state.cues.splice(index, 1);
    setCues(state.cues);
}
function shiftAllCues() {
    const ans = prompt('Shift all subtitle timestamps by (+/- seconds, e.g. 1.5 or -0.5):', '1.0');
    if (!ans)
        return;
    const dt = parseFloat(ans);
    if (isNaN(dt) || dt === 0)
        return;
    for (const c of state.cues) {
        c.start = Math.max(0, c.start + dt);
        c.end = Math.max(0, c.end + dt);
    }
    setCues(state.cues);
}
/* ───────────────────────── Subtitle History ───────────────────────── */
const HIST_KEY = 'vibe_gif_sub_history_v1';
let autoSnapTimer = null;
function loadHistoryList() {
    try {
        const raw = localStorage.getItem(HIST_KEY);
        return raw ? JSON.parse(raw) : [];
    }
    catch {
        return [];
    }
}
function saveHistoryList(list) {
    try {
        localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 100)));
    }
    catch (e) {
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
        if (!silent)
            alert('No subtitles to save in history.');
        return;
    }
    const preview = state.cues.slice(0, 3).map((c) => c.text.replace(/\n/g, ' ')).join(' / ').slice(0, 140);
    const item = {
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
    }
    else {
        list.unshift(item);
    }
    state.historyList = list;
    saveHistoryList(list);
    if (!silent) {
        setStatus(`Saved attempt (${item.cueCount} cues) to history`);
        update();
    }
}
function restoreAttempt(id) {
    const item = state.historyList.find((h) => h.id === id);
    if (!item)
        return;
    if (state.cues.length)
        snapshotAttempt('pre-switch', true);
    setCues(JSON.parse(JSON.stringify(item.cues)), true);
    if (item.sel && item.sel.end > item.sel.start)
        setSel(item.sel.start, item.sel.end);
    state.historyOpen = false;
    setStatus(`Restored subtitle attempt from ${new Date(item.timestamp).toLocaleTimeString()}`);
    update();
}
function deleteAttempt(id) {
    state.historyList = state.historyList.filter((h) => h.id !== id);
    saveHistoryList(state.historyList);
    update();
}
function clearAllHistory() {
    if (!confirm('Clear all subtitle history attempts?'))
        return;
    state.historyList = [];
    saveHistoryList([]);
    update();
}
function exportHistorySRT(id) {
    const item = state.historyList.find((h) => h.id === id);
    if (!item)
        return;
    const srt = S.toSRT(item.cues);
    const blob = new Blob([srt], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(item.videoTitle || 'subtitles')}_attempt_${new Date(item.timestamp).toISOString().slice(0, 10)}.srt`;
    a.click();
}
/* ───────────────────────── Rendering & Export ───────────────────────── */
function forceStyle() {
    const colorBgr = (hex) => {
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
    if (!state.srcBytes)
        return;
    if (dur < 0.1)
        return alert('Select a range on the timeline first.');
    const want = {
        mp4: state.outMp4,
        webp: state.outWebp,
        gif: state.outGif,
        srt: state.outSrt,
    };
    if (!Object.values(want).some(Boolean))
        return alert('Pick at least one output format.');
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
        if (!(want.mp4 || want.webp || want.gif))
            return;
        const f = await getFF();
        const src = await ensureSourceInFS();
        const hasSubs = srt.trim().length > 0;
        if (hasSubs)
            await f.writeFile('/work/subs.srt', new TextEncoder().encode(srt));
        const sub = hasSubs ? `subtitles=/work/subs.srt:fontsdir=/fonts:force_style='${forceStyle()}'` : '';
        const scale = width ? `scale=${width}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        const chain = (...xs) => xs.filter(Boolean).join(',');
        const input = ['-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
        const jobs = [];
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
            const data = (await f.readFile(out));
            await f.deleteFile(out);
            addResultItem(`${name}.${job.ext}`, job.ext, new Blob([data], { type: job.mime }));
            log(`→ ${name}.${job.ext} ${fmtBytes(data.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        }
        setStatus(`Rendered ${jobs.map((j) => j.ext.toUpperCase()).join(', ')}`);
    }
    catch (e) {
        if (state.busy && ff)
            console.error(e);
        setStatus(`Error: ${e.message}`);
        alert(`Render failed: ${e.message}`);
    }
    finally {
        setBusy(false);
    }
}
function addResultItem(name, ext, blob, text) {
    const item = {
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
async function saveResultNative(item) {
    try {
        const res = await fetch(`/api/save?name=${encodeURIComponent(item.name)}`, {
            method: 'POST',
            body: item.blob,
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok)
            throw new Error(out.error || `HTTP ${res.status}`);
        item.saved = true;
        item.savePath = out.path;
        setStatus(`Saved to ${out.path}`);
        update();
    }
    catch (e) {
        alert(`Save failed: ${e.message}`);
        setStatus(`Save failed: ${e.message}`);
    }
}
/* ───────────────────────── Files & Drag/Drop ───────────────────────── */
async function openFiles(files) {
    for (const file of files) {
        if (/\.(srt|vtt|json3?)$/i.test(file.name)) {
            if (state.cues.length && !confirm(`Replace current subtitles with ${file.name}?`))
                continue;
            setCues(S.parseSubtitles(await file.text(), file.name.endsWith('json3') ? 'json3' : ''));
            setStatus(`Loaded ${state.cues.length} cues from ${file.name}`);
        }
        else if (file.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(file.name)) {
            setCaptionTracks([]);
            setBusy(true);
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                await setSource(bytes, file.name, file.name);
            }
            finally {
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
    if (e.dataTransfer?.files.length)
        return openFiles(Array.from(e.dataTransfer.files));
    const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (text && /^https?:\/\//.test(text.trim())) {
        state.urlInput = text.trim();
        loadUrl(state.urlInput);
    }
});
document.addEventListener('paste', (e) => {
    if (e.target?.closest('input, textarea'))
        return;
    const text = e.clipboardData?.getData('text');
    if (text && /^https?:\/\//.test(text.trim())) {
        state.urlInput = text.trim();
        loadUrl(state.urlInput);
    }
});
window.addEventListener('keydown', (e) => {
    if (e.target?.closest('input, textarea'))
        return;
    if (e.code === 'Space') {
        e.preventDefault();
        if (video)
            (video.paused ? video.play() : video.pause());
    }
    else if (e.key === 'l' || e.key === 'L') {
        state.loopSel = !state.loopSel;
        if (state.loopSel && video) {
            video.currentTime = state.sel.start;
            video.play().catch(() => { });
        }
        update();
    }
    else if (e.key === 'i' || e.key === 'I') {
        if (video)
            setSel(video.currentTime, Math.max(video.currentTime + 0.1, state.sel.end));
    }
    else if (e.key === 'o' || e.key === 'O') {
        if (video)
            setSel(Math.min(state.sel.start, video.currentTime - 0.1), video.currentTime);
    }
    else if (e.key === 'z' || e.key === 'Z') {
        toggleZoom();
    }
    else if (e.key === 'a' || e.key === 'A') {
        addCueAtPlayhead();
    }
    else if (e.key === 'ArrowLeft' && video) {
        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 1 / 30));
    }
    else if (e.key === 'ArrowRight' && video) {
        video.currentTime = Math.min(state.duration, video.currentTime + (e.shiftKey ? 1 : 1 / 30));
    }
});
/* ───────────────────────── Shared YouTube URL Reception (Android / Web) ───────────────────────── */
function handleIncomingSharedUrl(rawUrl) {
    if (typeof rawUrl !== 'string')
        return;
    const url = rawUrl.trim();
    if (!url)
        return;
    state.urlInput = url;
    if (state.busy) {
        state.abort?.abort();
        if (progressCtx || ffLoading)
            killFF();
        setBusy(false);
    }
    loadUrl(url);
}
// Drain any early URLs buffered in window._pendingSharedUrls
const pendingEarlyUrls = Array.isArray(window._pendingSharedUrls) ? window._pendingSharedUrls.slice() : [];
window._pendingSharedUrls = [];
window.onSharedUrl = handleIncomingSharedUrl;
for (const earlyUrl of pendingEarlyUrls)
    handleIncomingSharedUrl(earlyUrl);
try {
    const bridge = window._AndroidShare;
    if (bridge && typeof bridge.getPendingUrl === 'function') {
        const nativePending = bridge.getPendingUrl();
        if (nativePending)
            handleIncomingSharedUrl(nativePending);
    }
}
catch (e) {
    console.warn('Could not read Android pending URL:', e);
}
/* ───────────────────────── TSX Component Views ───────────────────────── */
function renderApp() {
    const curTime = video ? video.currentTime : state.currentTime;
    const activeCues = state.cues.filter((c) => curTime >= c.start && curTime <= c.end);
    const overlayText = activeCues.map((c) => c.text).join('\n');
    const filteredHistory = state.historySearch
        ? state.historyList.filter((h) => h.videoTitle.toLowerCase().includes(state.historySearch.toLowerCase()) ||
            h.previewText.toLowerCase().includes(state.historySearch.toLowerCase()))
        : state.historyList;
    return (jsx("div", { id: "app", class: "app-root" },
        jsx("header", null,
            jsx("h1", null, "\u2702 Clip Editor"),
            jsx("form", { id: "url-form", onSubmit: (e) => {
                    e.preventDefault();
                    loadUrl(state.urlInput);
                } },
                jsx("input", { id: "url", type: "url", placeholder: "Paste a YouTube or direct video URL\u2026", autocomplete: "off", required: true, value: state.urlInput, onInput: (e) => {
                        state.urlInput = e.target.value;
                    } }),
                jsx("button", { type: "submit", class: "primary", disabled: state.busy }, "Load")),
            jsx("label", { class: "btn" },
                "Open file\u2026",
                jsx("input", { id: "file", type: "file", accept: "video/*,.srt,.vtt,.json3", multiple: true, hidden: true, onChange: (e) => {
                        openFiles([...e.target.files]);
                        e.target.value = '';
                    } })),
            jsx("button", { id: "btn-history", type: "button", class: "btn", title: "View past subtitle attempts", onClick: () => {
                    state.historyOpen = true;
                    update();
                } },
                "\uD83D\uDCDC History (",
                jsx("span", { id: "hist-count" }, state.historyList.length),
                ")"),
            jsx("span", { id: "status", class: "status", title: state.status }, state.status)),
        jsx("main", null,
            jsx("section", { class: "left" },
                jsx("div", { id: "stage", class: { stage: true, empty: !state.srcBytes } },
                    jsx("video", { key: "main-player-video", id: "video", playsinline: true, preload: "auto", hook: {
                            insert: (vn) => setupVideoElement(vn.elm),
                        } }),
                    jsx("div", { id: "overlay", class: "overlay", style: {
                            fontSize: `${state.stSize}px`,
                            bottom: `${state.stMargin}px`,
                            color: state.stColor,
                            textShadow: `-${state.stOutline}px -${state.stOutline}px 0 #000, ${state.stOutline}px -${state.stOutline}px 0 #000, -${state.stOutline}px ${state.stOutline}px 0 #000, ${state.stOutline}px ${state.stOutline}px 0 #000`,
                        } }, overlayText),
                    jsx("div", { class: "placeholder" }, "Paste a URL, open a file, or drop a video / .srt / .vtt anywhere"),
                    jsx("div", { id: "progress-wrap", class: "progress-wrap", hidden: !state.progressVisible },
                        jsx("div", { id: "progress-bar", style: {
                                width: state.progressFrac == null ? '100%' : `${(state.progressFrac * 100).toFixed(1)}%`,
                                opacity: state.progressFrac == null ? '0.35' : '1',
                            } }),
                        jsx("span", { id: "progress-text" }, state.progressText))),
                jsx("h2", { id: "title", class: "title" }, state.title),
                jsx("div", { class: "transport" },
                    jsx("button", { id: "play", title: "Play / pause (Space)", onClick: () => {
                            if (video)
                                (video.paused ? video.play() : video.pause());
                        } }, state.isPlaying ? '⏸' : '▶'),
                    jsx("button", { id: "play-sel", class: { primary: state.loopSel }, title: "Loop the selection (L)", onClick: () => {
                            state.loopSel = !state.loopSel;
                            if (state.loopSel && video) {
                                video.currentTime = state.sel.start;
                                video.play().catch(() => { });
                            }
                            update();
                        } }, "\u27F3 Selection"),
                    jsx("span", { class: "time", id: "cur" }, S.fmtShort(curTime)),
                    ' ',
                    "/ ",
                    jsx("span", { class: "time", id: "dur" }, S.fmtShort(state.duration)),
                    jsx("span", { class: "spacer" }),
                    jsx("label", null,
                        "In",
                        ' ',
                        jsx("input", { id: "sel-start", class: "t", value: S.fmtShort(state.sel.start), onChange: (e) => {
                                const v = S.parseTime(e.target.value);
                                if (!isNaN(v)) {
                                    setSel(v, state.sel.end);
                                    if (video)
                                        video.currentTime = state.sel.start;
                                }
                            } })),
                    jsx("button", { id: "set-start", title: "Set in-point to playhead (I)", onClick: () => {
                            if (video)
                                setSel(video.currentTime, Math.max(video.currentTime + 0.1, state.sel.end));
                        } }, "[ I"),
                    jsx("label", null,
                        "Out",
                        ' ',
                        jsx("input", { id: "sel-end", class: "t", value: S.fmtShort(state.sel.end), onChange: (e) => {
                                const v = S.parseTime(e.target.value);
                                if (!isNaN(v)) {
                                    setSel(state.sel.start, v);
                                    if (video)
                                        video.currentTime = state.sel.end;
                                }
                            } })),
                    jsx("button", { id: "set-end", title: "Set out-point to playhead (O)", onClick: () => {
                            if (video)
                                setSel(Math.min(state.sel.start, video.currentTime - 0.1), video.currentTime);
                        } }, "O ]"),
                    jsx("span", { class: "time dim", id: "sel-len" },
                        "(",
                        (state.sel.end - state.sel.start).toFixed(2),
                        "s)"),
                    jsx("button", { id: "fit", title: "Zoom timeline: whole video / selection (Z)", onClick: toggleZoom }, "Zoom")),
                jsx("canvas", { key: "timeline-canvas", id: "timeline", class: "timeline", height: 96, hook: {
                        insert: (vn) => setupTimelineCanvas(vn.elm),
                    } }),
                jsx("p", { class: "hint" }, "Drag on the timeline to select \u00B7 drag the yellow handles \u00B7 scroll to zoom \u00B7 \u2190/\u2192 step 1 frame (Shift: 1s) \u00B7 I / O set in/out"),
                jsx("details", { class: "panel", open: true },
                    jsx("summary", null, "Subtitle style"),
                    jsx("div", { class: "grid" },
                        jsx("label", null,
                            "Size",
                            ' ',
                            jsx("input", { id: "st-size", type: "range", min: "10", max: "40", value: state.stSize, onInput: (e) => {
                                    state.stSize = +e.target.value;
                                    update();
                                } }),
                            jsx("output", null,
                                state.stSize,
                                "px")),
                        jsx("label", null,
                            "Outline",
                            ' ',
                            jsx("input", { id: "st-outline", type: "range", min: "0", max: "5", step: "0.5", value: state.stOutline, onInput: (e) => {
                                    state.stOutline = +e.target.value;
                                    update();
                                } }),
                            jsx("output", null,
                                state.stOutline,
                                "px")),
                        jsx("label", null,
                            "Bottom margin",
                            ' ',
                            jsx("input", { id: "st-margin", type: "range", min: "0", max: "80", value: state.stMargin, onInput: (e) => {
                                    state.stMargin = +e.target.value;
                                    update();
                                } }),
                            jsx("output", null,
                                state.stMargin,
                                "px")),
                        jsx("label", null,
                            "Colour",
                            ' ',
                            jsx("input", { id: "st-color", type: "color", value: state.stColor, onInput: (e) => {
                                    state.stColor = e.target.value;
                                    update();
                                } })))),
                jsx("details", { class: "panel", open: true },
                    jsx("summary", null, "Export"),
                    jsx("div", { class: "grid" },
                        jsx("label", null,
                            jsx("input", { type: "checkbox", id: "out-mp4", checked: state.outMp4, onChange: (e) => {
                                    state.outMp4 = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            "MP4"),
                        jsx("label", null,
                            jsx("input", { type: "checkbox", id: "out-audio", checked: state.outAudio, onChange: (e) => {
                                    state.outAudio = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            "with audio"),
                        jsx("label", null,
                            jsx("input", { type: "checkbox", id: "out-webp", checked: state.outWebp, onChange: (e) => {
                                    state.outWebp = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            "Animated WebP"),
                        jsx("label", null,
                            jsx("input", { type: "checkbox", id: "out-gif", checked: state.outGif, onChange: (e) => {
                                    state.outGif = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            "GIF"),
                        jsx("label", null,
                            jsx("input", { type: "checkbox", id: "out-srt", checked: state.outSrt, onChange: (e) => {
                                    state.outSrt = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            ".srt"),
                        jsx("label", null,
                            "Width",
                            jsx("select", { id: "out-width", value: state.outWidth, onChange: (e) => {
                                    state.outWidth = +e.target.value;
                                    update();
                                } },
                                jsx("option", { value: "320" }, "320"),
                                jsx("option", { value: "480" }, "480"),
                                jsx("option", { value: "640" }, "640"),
                                jsx("option", { value: "720" }, "720"),
                                jsx("option", { value: "0" }, "source"))),
                        jsx("label", null,
                            "FPS (WebP/GIF)",
                            jsx("select", { id: "out-fps", value: state.outFps, onChange: (e) => {
                                    state.outFps = +e.target.value;
                                    update();
                                } },
                                jsx("option", { value: "10" }, "10"),
                                jsx("option", { value: "12" }, "12"),
                                jsx("option", { value: "15" }, "15"),
                                jsx("option", { value: "24" }, "24"))),
                        jsx("label", null,
                            "WebP quality",
                            ' ',
                            jsx("input", { id: "out-q", type: "range", min: "30", max: "95", value: state.outQuality, onInput: (e) => {
                                    state.outQuality = +e.target.value;
                                    update();
                                } }),
                            jsx("output", null, state.outQuality))),
                    jsx("div", { class: "row" },
                        jsx("input", { id: "out-name", placeholder: "file name", class: "grow", value: state.outName, onInput: (e) => {
                                state.outName = e.target.value;
                            } }),
                        jsx("button", { id: "render", class: "primary", disabled: state.busy || !state.srcBytes, onClick: render }, "Render"),
                        jsx("button", { id: "cancel", hidden: !state.busy, onClick: () => {
                                state.abort?.abort();
                                if (progressCtx || ffLoading)
                                    killFF();
                                setBusy(false);
                                setStatus('Cancelled');
                            } }, "Cancel")),
                    jsx("div", { id: "results", class: "results" }, state.results.map((res) => (jsx("div", { key: res.id, class: "result" },
                        res.ext === 'mp4' ? (jsx("video", { src: res.url, controls: true, loop: true, muted: true, autoplay: true, playsinline: true })) : res.ext === 'srt' ? (jsx("pre", null, res.text || '(no cues in selection)')) : (jsx("img", { src: res.url, alt: res.name })),
                        jsx("div", { class: "meta" },
                            NATIVE ? (jsx("button", { type: "button", class: "primary", disabled: res.saved, onClick: () => saveResultNative(res) }, res.saved ? '✓ Saved' : `💾 Save ${res.name}`)) : (jsx("a", { href: res.url, download: res.name },
                                "\u2B07 ",
                                res.name)),
                            jsx("span", { class: "dim" }, fmtBytes(res.size)))))))),
                jsx("details", { class: "panel" },
                    jsx("summary", null, "ffmpeg log"),
                    jsx("pre", { id: "log" }))),
            jsx("section", { class: "right" },
                jsx("div", { class: "subs-head" },
                    jsx("h2", null,
                        "Subtitles ",
                        jsx("span", { id: "cue-count", class: "dim" },
                            "(",
                            state.cues.length,
                            ")")),
                    jsx("div", { class: "row" },
                        jsx("select", { id: "tracks", class: "grow", value: state.selectedTrack, onChange: (e) => {
                                state.selectedTrack = +e.target.value;
                                update();
                            } }, state.captions.length ? (state.captions.map((c, i) => (jsx("option", { key: `track-${i}`, value: i },
                            c.name,
                            " [",
                            c.lang,
                            "]")))) : (jsx("option", { value: "" }, "\u2014 no caption tracks \u2014"))),
                        jsx("button", { id: "load-track", disabled: !state.captions.length, onClick: () => loadTrack(state.selectedTrack) }, "Load")),
                    jsx("div", { class: "row wrap" },
                        jsx("button", { id: "add-cue", title: "Add a cue at the playhead (A)", onClick: addCueAtPlayhead }, "+ Add"),
                        jsx("button", { id: "group", title: "Merge short neighbouring cues into readable chunks", onClick: () => setCues(S.autoGroup(state.cues)) }, "Group lines"),
                        jsx("button", { id: "tidy", title: "Capitalise sentence starts and 'I'", onClick: () => setCues(S.tidyCase(state.cues)) }, "Aa Tidy"),
                        jsx("button", { id: "shift", title: "Shift every cue by N seconds", onClick: shiftAllCues }, "Shift\u2026"),
                        jsx("button", { id: "clear-cues", title: "Remove all cues", onClick: () => {
                                if (confirm('Remove all subtitles?'))
                                    setCues([]);
                            } }, "Clear"),
                        jsx("button", { id: "btn-snap", title: "Save snapshot of current subtitles to history", onClick: () => snapshotAttempt('manual', false) }, "\uD83D\uDCBE Save Attempt"),
                        jsx("label", { class: "small" },
                            jsx("input", { type: "checkbox", id: "only-sel", checked: state.onlySel, onChange: (e) => {
                                    state.onlySel = e.target.checked;
                                    update();
                                } }),
                            ' ',
                            "only selection"))),
                jsx("div", { id: "cues", class: "cues" }, state.cues.length === 0 ? (jsx("div", { class: "empty-note" }, "No subtitles loaded. Click \"+ Add\" or drop an .srt / .vtt file.")) : (state.cues.map((c, i) => {
                    const active = curTime >= c.start && curTime <= c.end;
                    const outside = state.onlySel && (c.end < state.sel.start || c.start > state.sel.end);
                    return (jsx("div", { key: `cue-${i}`, class: { cue: true, active, outside } },
                        jsx("div", { class: "cue-times" },
                            jsx("button", { class: "seek", title: "Seek here", onClick: () => {
                                    if (video)
                                        video.currentTime = c.start + 0.001;
                                } }, "\u25B6"),
                            jsx("input", { class: "t c-start", value: S.fmtShort(c.start), onChange: (e) => updateCueTime(i, 'start', e.target.value) }),
                            jsx("button", { class: "now-start", title: "Start = playhead", onClick: () => updateCueTime(i, 'start', curTime) }, "\u23F1"),
                            jsx("input", { class: "t c-end", value: S.fmtShort(c.end), onChange: (e) => updateCueTime(i, 'end', e.target.value) }),
                            jsx("button", { class: "now-end", title: "End = playhead", onClick: () => updateCueTime(i, 'end', curTime) }, "\u23F1"),
                            jsx("span", { class: "spacer" }),
                            jsx("button", { class: "merge", title: "Merge with next cue", onClick: () => mergeWithNextCue(i) }, "\u21E3"),
                            jsx("button", { class: "del", title: "Delete cue", onClick: () => deleteCue(i) }, "\u2715")),
                        jsx("textarea", { class: "c-text", rows: 2, spellcheck: true, value: c.text, onInput: (e) => {
                                c.text = e.target.value;
                                scheduleAutoSnapshot();
                                update();
                            } })));
                }))))),
        state.historyOpen ? (jsx("dialog", { id: "history-dialog", class: "history-dialog", open: true, hook: {
                insert: (vn) => {
                    const d = vn.elm;
                    if (typeof d.showModal === 'function' && !d.open)
                        d.showModal();
                },
            }, onClick: (e) => {
                if (e.target.id === 'history-dialog') {
                    state.historyOpen = false;
                    update();
                }
            } },
            jsx("div", { class: "history-box" },
                jsx("div", { class: "history-header" },
                    jsx("div", { class: "row" },
                        jsx("h2", null, "\uD83D\uDCDC Subtitle History"),
                        jsx("span", { class: "spacer" }),
                        jsx("button", { id: "hist-save-now", class: "primary", title: "Snapshot current subtitles", onClick: () => snapshotAttempt('manual', false) }, "+ Snapshot Current"),
                        jsx("button", { id: "hist-clear", class: "btn", title: "Clear all subtitle history", onClick: clearAllHistory }, "Clear All"),
                        jsx("button", { id: "hist-close", class: "btn", title: "Close dialog", onClick: () => {
                                state.historyOpen = false;
                                update();
                            } }, "\u2715")),
                    jsx("p", { class: "hint" }, "Switch back to any previous subtitling attempt at any time. Video is not duplicated; only subtitle changes, timings, and selection are preserved."),
                    jsx("div", { class: "row" },
                        jsx("input", { id: "hist-search", type: "search", placeholder: "Search by video title or subtitle text\u2026", class: "grow", value: state.historySearch, onInput: (e) => {
                                state.historySearch = e.target.value;
                                update();
                            } }))),
                jsx("div", { id: "hist-list", class: "history-list" }, filteredHistory.length === 0 ? (jsx("div", { class: "empty-note" }, "No matching subtitle history.")) : (filteredHistory.map((item) => {
                    const d = new Date(item.timestamp);
                    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
                        ' ' +
                        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    return (jsx("div", { key: item.id, class: "hist-card" },
                        jsx("div", { class: "hist-top" },
                            jsx("span", { class: "hist-title", title: item.videoTitle }, item.videoTitle),
                            jsx("span", { class: "hist-date" }, dateStr)),
                        jsx("div", { class: "hist-meta" },
                            jsx("span", { class: "badge" },
                                item.cueCount,
                                " cues"),
                            item.sel && item.sel.end > item.sel.start ? (jsx("span", { class: "badge" },
                                "Range: ",
                                S.fmtShort(item.sel.start),
                                " \u2013 ",
                                S.fmtShort(item.sel.end))) : null,
                            jsx("span", { class: "dim" },
                                "Tag: ",
                                item.sourceLabel || 'snapshot')),
                        jsx("div", { class: "hist-preview" }, item.previewText || '(empty cues)'),
                        jsx("div", { class: "hist-actions" },
                            jsx("button", { class: "primary act-switch", type: "button", onClick: () => restoreAttempt(item.id) }, "\u21BB Switch to this attempt"),
                            jsx("button", { class: "btn act-export", type: "button", onClick: () => exportHistorySRT(item.id) }, "\u2B07 .srt"),
                            jsx("button", { class: "btn del act-del", type: "button", onClick: () => deleteAttempt(item.id) }, "\u2715"))));
                })))))) : null));
}
// Initial mount
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => update());
}
else {
    update();
}
