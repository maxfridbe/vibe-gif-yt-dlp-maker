// Subtitle parsing / cleanup / serialization. Cues are {start, end, text} in seconds.
export function fmtTime(t, sep = '.') {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    // carry rounding (e.g. 59.9996 -> 1:00.000)
    if (ms === 1000)
        return fmtTime(Math.floor(t) + 1, sep);
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}
/** Short editor format: m:ss.cc (or h:mm:ss.cc). */
export function fmtShort(t) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
/** Accepts "12.5", "1:02.3", "01:02:03,450" etc. Returns NaN if invalid. */
export function parseTime(str) {
    const parts = String(str).trim().replace(',', '.').split(':');
    if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || isNaN(p)))
        return NaN;
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}
const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
function parseBlocks(text) {
    // Shared parser for SRT and WebVTT cue blocks.
    const cues = [];
    const blocks = text.replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n');
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0)
            continue;
        const [a, b] = lines[i].split('-->');
        const start = parseTime(a);
        const end = parseTime(b.trim().split(/\s+/)[0]);
        if (isNaN(start) || isNaN(end))
            continue;
        const body = lines.slice(i + 1).map((l) => stripTags(l).trim());
        cues.push({ start, end, text: body.join('\n') });
    }
    return cues;
}
/**
 * YouTube auto-captions "roll": each cue repeats the previous line above the new one,
 * plus ~10ms filler cues. Keep only the new line(s) of each cue.
 */
export function dedupeRolling(cues) {
    const out = [];
    let prevLines = [];
    for (const c of cues) {
        const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
        const fresh = lines.filter((l) => !prevLines.includes(l));
        if (lines.length)
            prevLines = lines;
        if (!fresh.length || c.end - c.start < 0.05)
            continue;
        out.push({ start: c.start, end: c.end, text: fresh.join('\n') });
    }
    return fixOverlaps(out);
}
function fixOverlaps(cues) {
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
        if (cues[i].end > cues[i + 1].start)
            cues[i].end = cues[i + 1].start;
    }
    return cues.filter((c) => c.end - c.start > 0.01);
}
/** YouTube json3 timedtext. Events carry one caption line each; "\n"-only events are spacers. */
export function parseJson3(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const cues = [];
    for (const ev of data.events || []) {
        if (!ev.segs)
            continue;
        const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s*\n\s*/g, '\n').trim();
        if (!text)
            continue;
        const start = (ev.tStartMs || 0) / 1000;
        cues.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
    }
    return fixOverlaps(cues);
}
export function parseSubtitles(text, hint = '') {
    const t = text.trimStart();
    if (hint === 'json3' || t.startsWith('{'))
        return parseJson3(t);
    return dedupeRolling(parseBlocks(t));
}
export function toSRT(cues, offset = 0, clipLen = Infinity) {
    let n = 0;
    return cues
        .map((c) => ({ ...c, start: c.start - offset, end: c.end - offset }))
        .filter((c) => c.end > 0 && c.start < clipLen && c.text.trim())
        .map((c) => `${++n}\n${fmtTime(Math.max(0, c.start), ',')} --> ${fmtTime(Math.min(clipLen, c.end), ',')}\n${c.text.trim()}\n`)
        .join('\n');
}
/** Merge neighbouring short cues into readable chunks (joined with spaces; renderer wraps). */
export function autoGroup(cues, maxChars = 84, maxGap = 0.35) {
    const out = [];
    for (const c of cues) {
        const last = out[out.length - 1];
        const text = c.text.replace(/\n/g, ' ');
        if (last && c.start - last.end <= maxGap && last.text.length + 1 + text.length <= maxChars) {
            last.text += ' ' + text;
            last.end = c.end;
        }
        else
            out.push({ start: c.start, end: c.end, text });
    }
    return out;
}
/** Capitalise sentence starts and standalone "i". Cheap tidy-up for auto captions. */
export function tidyCase(cues) {
    let sentenceStart = true;
    return cues.map((c) => {
        let text = c.text.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|d|ve)\b/gi, (m) => 'I' + m.slice(1));
        text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, ch) => p + ch.toUpperCase());
        if (sentenceStart)
            text = text.replace(/^([a-z])/, (m) => m.toUpperCase());
        sentenceStart = /[.!?]["')\]]?$/.test(text.trim());
        return { ...c, text };
    });
}
