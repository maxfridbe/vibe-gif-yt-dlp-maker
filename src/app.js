/// <reference lib="dom" />
// Clip Editor – all media work happens here in the browser via ffmpeg.wasm.
// proxy.py only serves these files, resolves YouTube URLs (yt-dlp) and relays allowlisted GETs.
import { FFmpeg } from './vendor/ffmpeg/index.js';
import * as S from './subs.js';
const $ = (id) => document.getElementById(id);
const video = $('video');
const tl = $('timeline');
const ctx = tl.getContext('2d');
const state = {
    title: '',
    duration: 0,
    srcBytes: null, // Uint8Array of the (muxed) source
    srcName: '', // file name inside ffmpeg FS (/work/<name>)
    srcInFS: false,
    cues: [],
    sel: { start: 0, end: 0 },
    view: { from: 0, to: 0 },
    captions: [],
    loopSel: false,
    busy: false,
    abort: null,
    pendingStart: null, // from ?t= in a YouTube URL
};
/* ───────────────────────── ffmpeg.wasm ───────────────────────── */
let ff = null;
let ffLoading = null;
let progressCtx = null; // {label, dur}
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
    })().catch((e) => { ffLoading = null; throw e; });
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
            const el = $('log');
            el.textContent = logLines.join('\n');
            el.scrollTop = el.scrollHeight;
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
    if (!state.srcInFS) {
        // writeFile transfers the buffer to the worker, so hand it a copy.
        await f.writeFile(`/work/${state.srcName}`, state.srcBytes.slice());
        state.srcInFS = true;
    }
    return `/work/${state.srcName}`;
}
/* ───────────────────────── UI helpers ───────────────────────── */
function setStatus(text) { $('status').textContent = text; $('status').title = text; }
function showProgress(frac, text) {
    $('progress-wrap').hidden = false;
    const bar = $('progress-bar');
    bar.style.width = frac == null ? '100%' : `${(frac * 100).toFixed(1)}%`;
    bar.style.opacity = frac == null ? 0.35 : 1;
    $('progress-text').textContent = text || '';
}
function hideProgress() { $('progress-wrap').hidden = true; }
function setBusy(busy) {
    state.busy = busy;
    $('render').disabled = busy || !state.srcBytes;
    document.querySelector('#url-form button').disabled = busy;
    $('cancel').hidden = !busy;
    if (!busy) {
        hideProgress();
        state.abort = null;
    }
}
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const slug = (s) => (s || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'clip';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mimeFor = (name) => ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' }[name.split('.').pop().toLowerCase()] || 'video/mp4');
async function api(path) {
    const res = await fetch(path, { signal: state.abort?.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}
/* ───────────────────────── Fetching media ───────────────────────── */
/** Download through /api/fetch in Range chunks (YouTube throttles single huge requests). */
async function download(url, label, sizeHint = 0) {
    const CHUNK = 8 * 1024 * 1024;
    const parts = [];
    let got = 0;
    let total = sizeHint || 0;
    const signal = state.abort?.signal;
    for (;;) {
        const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
            headers: { Range: `bytes=${got}-${got + CHUNK - 1}` }, signal,
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
            total = +res.headers.get('content-length') || total;
        const reader = res.body.getReader();
        let chunkGot = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            parts.push(value);
            got += value.length;
            chunkGot += value.length;
            showProgress(total ? got / total : null, `Downloading ${label} ${fmtBytes(got)}${total ? ' / ' + fmtBytes(total) : ''}`);
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
            state.pendingStart = hms ? (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0)) || null : null;
            showProgress(null, 'Resolving with yt-dlp…');
            setStatus('Resolving…');
            const info = await api(`/api/resolve?url=${encodeURIComponent(url)}`);
            state.title = info.title || '';
            setCaptionTracks(info.captions || []);
            const v = await download(info.video.url, 'video', info.video.size);
            let bytes = v;
            let name = `source.${info.video.ext || 'mp4'}`;
            if (info.audio) {
                const a = await download(info.audio.url, 'audio', info.audio.size);
                ({ bytes, name } = await mux(v, info.video.ext, a, info.audio.ext));
            }
            await setSource(bytes, name, state.title, !!info.audio);
            const track = (info.captions || [])[0];
            if (track)
                await loadTrack(0, false);
        }
        else {
            showProgress(null, 'Downloading…');
            const bytes = await download(url, 'video');
            const name = decodeURIComponent(u.pathname.split('/').pop() || 'video.mp4');
            setCaptionTracks([]);
            await setSource(bytes, /\.\w+$/.test(name) ? name : name + '.mp4', name);
        }
    }
    catch (e) {
        if (e.name !== 'AbortError' && state.busy) {
            console.error(e);
            alert(e.message);
            setStatus(`Error: ${e.message}`);
        }
    }
    finally {
        setBusy(false);
    }
}
/** Merge separate DASH video + audio into one file for preview + rendering (stream copy, fast). */
async function mux(vBytes, vExt, aBytes, aExt) {
    const f = await getFF();
    const ext = vExt === 'mp4' && /^(m4a|mp4)$/.test(aExt) ? 'mp4' : vExt === 'webm' && aExt === 'webm' ? 'webm' : 'mkv';
    await f.writeFile(`/work/v.${vExt}`, vBytes);
    await f.writeFile(`/work/a.${aExt}`, aBytes);
    if (state.srcName)
        await f.deleteFile(`/work/${state.srcName}`).catch(() => { });
    const name = `source.${ext}`;
    await run(['-y', '-i', `/work/v.${vExt}`, '-i', `/work/a.${aExt}`, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', `/work/${name}`], 'Merging audio + video');
    await f.deleteFile(`/work/v.${vExt}`);
    await f.deleteFile(`/work/a.${aExt}`);
    const bytes = await f.readFile(`/work/${name}`);
    return { bytes, name, inFS: true };
}
async function setSource(bytes, name, title, alreadyInFS = false) {
    if (ff && state.srcName && !alreadyInFS)
        await ff.deleteFile(`/work/${state.srcName}`).catch(() => { });
    state.srcBytes = bytes;
    state.srcName = name.replace(/[^\w.-]/g, '_');
    state.srcInFS = alreadyInFS && name === state.srcName;
    state.title = title || name;
    $('title').textContent = state.title;
    $('out-name').value = slug(state.title);
    if (video.src)
        URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) }));
    $('stage').classList.remove('empty');
    setStatus(`Loaded ${state.srcName} (${fmtBytes(bytes.length)})`);
    await new Promise((resolve) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => { alert("The browser can't preview this file's codec. Try an MP4/WebM."); resolve(void 0); };
    });
    state.duration = Number.isFinite(video.duration) ? video.duration : 0;
    $('dur').textContent = S.fmtShort(state.duration);
    const start = clamp(state.pendingStart ?? 0, 0, state.duration);
    state.pendingStart = null;
    setSel(start, state.duration <= 30 && start === 0 ? state.duration : Math.min(state.duration, start + 10));
    state.view = { from: 0, to: state.duration };
    video.currentTime = start;
    $('render').disabled = false;
    renderCues();
}
/* ───────────────────────── Captions ───────────────────────── */
function setCaptionTracks(list) {
    state.captions = list;
    const sel = $('tracks');
    sel.innerHTML = list.length
        ? list.map((c, i) => `<option value="${i}">${c.name} [${c.lang}]</option>`).join('')
        : '<option value="">— no caption tracks —</option>';
    $('load-track').disabled = !list.length;
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
function setCues(cues) {
    state.cues = cues.sort((a, b) => a.start - b.start);
    renderCues();
}
/* ───────────────────────── Selection & timeline ───────────────────────── */
function setSel(start, end) {
    start = clamp(start, 0, state.duration);
    end = clamp(end, 0, state.duration);
    if (end < start)
        [start, end] = [end, start];
    state.sel = { start, end };
    $('sel-start').value = S.fmtShort(start);
    $('sel-end').value = S.fmtShort(end);
    $('sel-len').textContent = `(${(end - start).toFixed(2)}s)`;
}
const dpr = () => window.devicePixelRatio || 1;
const tToX = (t) => ((t - state.view.from) / (state.view.to - state.view.from || 1)) * tl.width;
const xToT = (x) => state.view.from + (x / tl.width) * (state.view.to - state.view.from);
function drawTimeline() {
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
    // ruler
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
    // cues
    const cy = 36 * r, ch = 30 * r;
    ctx.font = `${11 * r}px system-ui`;
    for (const c of state.cues) {
        if (c.end < from || c.start > to)
            continue;
        const x0 = tToX(c.start), x1 = tToX(c.end);
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
    // selection
    const sx = tToX(state.sel.start), ex = tToX(state.sel.end);
    ctx.fillStyle = 'rgba(255,210,63,0.16)';
    ctx.fillRect(sx, 14 * r, ex - sx, H - 14 * r);
    ctx.fillStyle = '#ffd23f';
    for (const x of [sx, ex]) {
        ctx.fillRect(x - 1.5 * r, 14 * r, 3 * r, H - 14 * r);
        ctx.fillRect(x - 5 * r, H - 14 * r, 10 * r, 14 * r);
    }
    // playhead
    const px = tToX(video.currentTime);
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(px - r, 0, 2 * r, H);
}
let drag = null;
tl.addEventListener('pointerdown', (e) => {
    if (!state.duration)
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
        video.currentTime = t;
    }
    if (drag.kind !== 'new')
        video.pause();
});
tl.addEventListener('pointermove', (e) => {
    const x = e.offsetX * dpr();
    const t = clamp(xToT(x), 0, state.duration);
    if (!drag) {
        const near = (tt) => Math.abs(tToX(tt) - x) < 8 * dpr();
        tl.style.cursor = state.duration && (near(state.sel.start) || near(state.sel.end)) ? 'ew-resize' : 'crosshair';
        return;
    }
    if (drag.kind === 'start') {
        setSel(Math.min(t, state.sel.end - 0.05), state.sel.end);
        video.currentTime = state.sel.start;
    }
    else if (drag.kind === 'end') {
        setSel(state.sel.start, Math.max(t, state.sel.start + 0.05));
        video.currentTime = state.sel.end;
    }
    else if (Math.abs(x - drag.x0) > 4 * dpr()) {
        setSel(drag.anchor, t);
        video.currentTime = t;
    }
});
tl.addEventListener('pointerup', () => { if (drag) {
    drag = null;
    renderCues();
} });
tl.addEventListener('wheel', (e) => {
    if (!state.duration)
        return;
    e.preventDefault();
    const { from, to } = state.view;
    let span = to - from;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / tl.clientWidth) * span;
        const nf = clamp(from + d, 0, state.duration - span);
        state.view = { from: nf, to: nf + span };
        return;
    }
    const t = xToT(e.offsetX * dpr());
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    span = clamp(span * k, 0.5, state.duration);
    let nf = t - (t - from) * (span / (to - from));
    nf = clamp(nf, 0, state.duration - span);
    state.view = { from: nf, to: nf + span };
}, { passive: false });
function toggleZoom() {
    const whole = state.view.from === 0 && state.view.to === state.duration;
    if (whole) {
        const pad = Math.max(0.5, (state.sel.end - state.sel.start) * 0.15);
        state.view = { from: Math.max(0, state.sel.start - pad), to: Math.min(state.duration, state.sel.end + pad) };
    }
    else
        state.view = { from: 0, to: state.duration };
}
/* ───────────────────────── Subtitle overlay & cue list ───────────────────────── */
const style = () => ({
    size: +$('st-size').value,
    outline: +$('st-outline').value,
    margin: +$('st-margin').value,
    color: $('st-color').value,
});
/** ASS colour is &HAABBGGRR. */
const assColor = (hex) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
function forceStyle() {
    const s = style();
    return [
        'FontName=DejaVu Sans', 'Bold=1', `Fontsize=${s.size}`, `PrimaryColour=${assColor(s.color)}`,
        'OutlineColour=&H00000000', 'BorderStyle=1', `Outline=${s.outline}`, 'Shadow=0', `MarginV=${s.margin}`,
    ].join(',');
}
/** Mirror libass layout: ffmpeg's SRT→ASS uses a 384×288 script resolution scaled to the frame. */
function layoutOverlay() {
    const ov = $('overlay');
    const stage = $('stage').getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const k = Math.min(stage.width / vw, stage.height / vh);
    const dw = vw * k, dh = vh * k;
    const ox = (stage.width - dw) / 2, oy = (stage.height - dh) / 2;
    const sy = dh / 288, sx = dw / 384;
    const s = style();
    ov.style.left = `${ox + 10 * sx}px`;
    ov.style.right = `${ox + 10 * sx}px`;
    ov.style.bottom = `${oy + s.margin * sy}px`;
    ov.style.fontSize = `${(s.size * sy) / 1.164}px`; // ASS size ≈ ascent+descent; DejaVu em ratio
    ov.style.color = s.color;
    const o = s.outline * sy;
    const shadows = [];
    for (let a = 0; a < 16; a++) {
        const th = (a / 16) * Math.PI * 2;
        shadows.push(`${(Math.cos(th) * o).toFixed(2)}px ${(Math.sin(th) * o).toFixed(2)}px 0 #000`);
    }
    ov.style.textShadow = o ? shadows.join(',') : 'none';
}
let activeIdx = -1;
function updateOverlay() {
    const t = video.currentTime;
    const idx = state.cues.findIndex((c) => t >= c.start && t < c.end);
    const text = idx >= 0 ? state.cues[idx].text : '';
    const ov = $('overlay');
    if (ov.textContent !== text)
        ov.textContent = text;
    if (idx !== activeIdx) {
        document.querySelector('.cue.active')?.classList.remove('active');
        const el = document.querySelector(`.cue[data-idx="${idx}"]`);
        if (el) {
            el.classList.add('active');
            if (!video.paused && !el.contains(document.activeElement))
                el.scrollIntoView({ block: 'nearest' });
        }
        activeIdx = idx;
    }
}
function renderCues() {
    const list = $('cues');
    const onlySel = $('only-sel').checked;
    const { start, end } = state.sel;
    list.textContent = '';
    const tpl = $('cue-tpl').content;
    let shown = 0;
    state.cues.forEach((c, i) => {
        const inSel = c.end > start && c.start < end;
        if (onlySel && state.duration && !inSel)
            return;
        const el = tpl.firstElementChild.cloneNode(true);
        el.dataset.idx = String(i);
        el.classList.toggle('outside', !inSel);
        el.querySelector('.c-start').value = S.fmtShort(c.start);
        el.querySelector('.c-end').value = S.fmtShort(c.end);
        el.querySelector('.c-text').value = c.text;
        list.appendChild(el);
        shown++;
    });
    if (!shown) {
        list.innerHTML = `<div class="empty-note">${state.cues.length ? 'No cues inside the selection.' : 'No subtitles yet — load a caption track, drop an .srt/.vtt, or press “+ Add”.'}</div>`;
    }
    $('cue-count').textContent = state.cues.length ? `(${shown}/${state.cues.length})` : '';
    activeIdx = -2; // force re-highlight
}
$('cues').addEventListener('input', (e) => {
    const el = e.target.closest('.cue');
    if (el && e.target.classList.contains('c-text'))
        state.cues[+el.dataset.idx].text = e.target.value;
});
$('cues').addEventListener('change', (e) => {
    const el = e.target.closest('.cue');
    if (!el || !e.target.classList.contains('t'))
        return;
    const c = state.cues[+el.dataset.idx];
    const v = S.parseTime(e.target.value);
    if (isNaN(v)) {
        e.target.classList.add('bad');
        return;
    }
    e.target.classList.remove('bad');
    if (e.target.classList.contains('c-start'))
        c.start = v;
    else
        c.end = v;
    if (c.end < c.start)
        [c.start, c.end] = [c.end, c.start];
    setCues(state.cues);
});
$('cues').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const el = e.target.closest('.cue');
    if (!btn || !el)
        return;
    const i = +el.dataset.idx;
    const c = state.cues[i];
    const t = video.currentTime;
    if (btn.classList.contains('seek')) {
        video.currentTime = c.start + 0.001;
        return;
    }
    if (btn.classList.contains('now-start'))
        c.start = Math.min(t, c.end - 0.05);
    else if (btn.classList.contains('now-end'))
        c.end = Math.max(t, c.start + 0.05);
    else if (btn.classList.contains('merge')) {
        const n = state.cues[i + 1];
        if (!n)
            return;
        c.text = `${c.text.trim()} ${n.text.trim()}`;
        c.end = n.end;
        state.cues.splice(i + 1, 1);
    }
    else if (btn.classList.contains('del'))
        state.cues.splice(i, 1);
    setCues(state.cues);
});
function addCue() {
    const t = video.currentTime || 0;
    const next = state.cues.find((c) => c.start > t);
    const cue = { start: t, end: Math.min(state.duration || t + 2, next ? next.start : t + 2, t + 2), text: '' };
    if (cue.end - cue.start < 0.2)
        cue.end = t + 0.5;
    state.cues.push(cue);
    setCues(state.cues);
    const idx = state.cues.indexOf(cue);
    document.querySelector(`\.cue[data-idx="${idx}"] textarea`)?.focus();
}
/* ───────────────────────── Rendering ───────────────────────── */
async function render() {
    const { start, end } = state.sel;
    const dur = end - start;
    if (!state.srcBytes)
        return;
    if (dur < 0.1)
        return alert('Select a range on the timeline first.');
    const want = {
        mp4: $('out-mp4').checked, webp: $('out-webp').checked, gif: $('out-gif').checked, srt: $('out-srt').checked,
    };
    if (!Object.values(want).some(Boolean))
        return alert('Pick at least one output format.');
    const name = slug($('out-name').value || state.title);
    const width = +$('out-width').value;
    const fps = +$('out-fps').value;
    const q = $('out-q').value;
    const srt = S.toSRT(state.cues, start, dur);
    setBusy(true);
    try {
        if (want.srt)
            addResult(`${name}.srt`, new Blob([srt], { type: 'text/plain' }), srt);
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
        if (want.mp4)
            jobs.push({
                ext: 'mp4', label: 'Encoding MP4', mime: 'video/mp4',
                args: [...input, '-vf', chain(scale, sub), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                    '-pix_fmt', 'yuv420p', ...($('out-audio').checked ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
                    '-movflags', '+faststart'],
            });
        if (want.webp)
            jobs.push({
                ext: 'webp', label: 'Encoding WebP', mime: 'image/webp',
                args: [...input, '-vf', chain(`fps=${fps}`, scale, sub), '-c:v', 'libwebp', '-quality', q,
                    '-compression_level', '4', '-loop', '0', '-an'],
            });
        if (want.gif)
            jobs.push({
                ext: 'gif', label: 'Encoding GIF', mime: 'image/gif',
                args: [...input, '-filter_complex',
                    `${chain(`fps=${fps}`, scale, sub)},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
                    '-loop', '0', '-an'],
            });
        for (const job of jobs) {
            const out = `/work/out.${job.ext}`;
            const t0 = performance.now();
            await run([...job.args, out], job.label, dur);
            const data = await f.readFile(out);
            await f.deleteFile(out);
            addResult(`${name}.${job.ext}`, new Blob([data], { type: job.mime }));
            log(`→ ${name}.${job.ext} ${fmtBytes(data.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        }
        setStatus(`Rendered ${jobs.map((j) => j.ext.toUpperCase()).join(', ')}`);
    }
    catch (e) {
        if (state.busy && ff) {
            console.error(e);
            alert(e.message);
        }
        setStatus(`Error: ${e.message}`);
    }
    finally {
        setBusy(false);
    }
}
function addResult(filename, blob, text) {
    const url = URL.createObjectURL(blob);
    const card = document.createElement('div');
    card.className = 'result';
    const ext = filename.split('.').pop();
    if (ext === 'mp4') {
        const v = document.createElement('video');
        Object.assign(v, { src: url, controls: true, loop: true, muted: true, autoplay: true, playsInline: true });
        card.appendChild(v);
    }
    else if (ext === 'srt') {
        const pre = document.createElement('pre');
        pre.textContent = text || '(no cues in selection)';
        card.appendChild(pre);
    }
    else {
        const img = document.createElement('img');
        img.src = url;
        img.alt = filename;
        card.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.textContent = `⬇ ${filename}`;
    const size = document.createElement('span');
    size.className = 'dim';
    size.textContent = fmtBytes(blob.size);
    meta.append(a, size);
    card.appendChild(meta);
    $('results').prepend(card);
}
/* ───────────────────────── Files, drag & drop, paste ───────────────────────── */
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
            showProgress(null, `Reading ${file.name}…`);
            try {
                await setSource(new Uint8Array(await file.arrayBuffer()), file.name, file.name.replace(/\.\w+$/, ''));
            }
            finally {
                setBusy(false);
            }
        }
    }
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
} });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length)
        return openFiles(Array.from(e.dataTransfer.files));
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (/^https?:\/\//.test(text)) {
        $('url').value = text.trim();
        loadUrl(text);
    }
});
document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea'))
        return;
    const text = e.clipboardData.getData('text');
    if (/^https?:\/\//.test(text.trim())) {
        $('url').value = text.trim();
        loadUrl(text);
    }
});
/* ───────────────────────── Wiring ───────────────────────── */
$('url-form').addEventListener('submit', (e) => { e.preventDefault(); loadUrl($('url').value); });
$('file').addEventListener('change', (e) => { openFiles([...e.target.files]); e.target.value = ''; });
$('play').onclick = () => (video.paused ? video.play() : video.pause());
$('play-sel').onclick = () => {
    state.loopSel = !state.loopSel;
    $('play-sel').classList.toggle('primary', state.loopSel);
    if (state.loopSel) {
        video.currentTime = state.sel.start;
        video.play();
    }
};
$('set-start').onclick = () => { setSel(video.currentTime, Math.max(video.currentTime + 0.1, state.sel.end)); renderCues(); };
$('set-end').onclick = () => { setSel(Math.min(state.sel.start, video.currentTime - 0.1), video.currentTime); renderCues(); };
for (const id of ['sel-start', 'sel-end']) {
    $(id).addEventListener('change', (e) => {
        const v = S.parseTime(e.target.value);
        if (isNaN(v)) {
            e.target.classList.add('bad');
            return;
        }
        e.target.classList.remove('bad');
        if (id === 'sel-start')
            setSel(v, state.sel.end);
        else
            setSel(state.sel.start, v);
        video.currentTime = id === 'sel-start' ? state.sel.start : state.sel.end;
        renderCues();
    });
}
$('fit').onclick = toggleZoom;
$('load-track').onclick = () => loadTrack(+$('tracks').value).catch((e) => alert(e.message));
$('add-cue').onclick = addCue;
$('group').onclick = () => setCues(S.autoGroup(state.cues));
$('tidy').onclick = () => setCues(S.tidyCase(state.cues));
$('shift').onclick = () => {
    const v = parseFloat(prompt('Shift all cues by how many seconds? (negative = earlier)', '0.5'));
    if (!isNaN(v))
        setCues(state.cues.map((c) => ({ ...c, start: Math.max(0, c.start + v), end: Math.max(0, c.end + v) })));
};
$('clear-cues').onclick = () => { if (confirm('Remove all subtitles?'))
    setCues([]); };
$('only-sel').onchange = renderCues;
$('render').onclick = render;
$('cancel').onclick = () => {
    state.abort?.abort();
    if (progressCtx || ffLoading)
        killFF(); // terminate a running ffmpeg job
    setBusy(false);
    setStatus('Cancelled');
};
video.addEventListener('play', () => ($('play').textContent = '❚❚'));
video.addEventListener('pause', () => ($('play').textContent = '▶'));
// live value labels for range inputs
document.querySelectorAll('input[type=range]').forEach((r) => {
    const out = r.parentElement.querySelector('output');
    const upd = () => { if (out)
        out.textContent = r.value; layoutOverlay(); };
    r.addEventListener('input', upd);
    upd();
});
$('st-color').addEventListener('input', layoutOverlay);
new ResizeObserver(layoutOverlay).observe($('stage'));
video.addEventListener('loadedmetadata', layoutOverlay);
document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey)
        return;
    const step = e.shiftKey ? 1 : 1 / 30;
    switch (e.key) {
        case ' ':
            e.preventDefault();
            $('play').click();
            break;
        case 'i':
        case 'I':
            $('set-start').click();
            break;
        case 'o':
        case 'O':
            $('set-end').click();
            break;
        case 'l':
        case 'L':
            $('play-sel').click();
            break;
        case 'a':
        case 'A':
            addCue();
            e.preventDefault();
            break;
        case 'z':
        case 'Z':
            toggleZoom();
            break;
        case 'ArrowLeft':
            video.pause();
            video.currentTime = Math.max(0, video.currentTime - step);
            break;
        case 'ArrowRight':
            video.pause();
            video.currentTime = Math.min(state.duration, video.currentTime + step);
            break;
        default: return;
    }
});
(function tick() {
    if (state.loopSel && !video.paused && video.currentTime >= state.sel.end)
        video.currentTime = state.sel.start;
    $('cur').textContent = S.fmtShort(video.currentTime);
    updateOverlay();
    drawTimeline();
    requestAnimationFrame(tick);
})();
renderCues();
// Warm up ffmpeg.wasm in the background so the first merge/render is quick.
getFF().catch((e) => setStatus(`ffmpeg.wasm failed to load: ${e.message}`));
