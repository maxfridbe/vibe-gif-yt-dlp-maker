// Subtitle parsing / cleanup / serialization. Cues are {start, end, text} in seconds.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function fmtTime(t: number, sep: string = '.'): string {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  // carry rounding (e.g. 59.9996 -> 1:00.000)
  if (ms === 1000)
    return fmtTime(Math.floor(t) + 1, sep);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

/** Short editor format: m:ss.cc (or h:mm:ss.cc). */
export function fmtShort(t: number): string {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Accepts "12.5", "1:02.3", "01:02:03,450" etc. Returns NaN if invalid. */
export function parseTime(str: string | number): number {
  const parts = String(str).trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p))))
    return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

const stripTags = (s: string): string =>
  s.replace(/<br\s*\/?>/gi, '\n')
   .replace(/<[^>]*>/g, '')
   .replace(/&amp;/g, '&')
   .replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>')
   .replace(/&nbsp;/g, ' ')
   .replace(/&apos;/g, "'")
   .replace(/&quot;/g, '"')
   .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
   .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

function parseBlocks(text: string): Cue[] {
  // Shared parser for SRT and WebVTT cue blocks.
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (isNaN(start) || isNaN(end)) continue;
    const body = lines.slice(i + 1).map((l) => stripTags(l).trim());
    cues.push({ start, end, text: body.join('\n') });
  }
  return cues;
}

/**
 * YouTube auto-captions "roll": each cue repeats the previous line above the new one,
 * plus ~10ms filler cues. Keep only the new line(s) of each cue.
 */
export function dedupeRolling(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  let prevLines: string[] = [];
  for (const c of cues) {
    const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const fresh = lines.filter((l) => !prevLines.includes(l));
    if (lines.length) prevLines = lines;
    if (!fresh.length || c.end - c.start < 0.05) continue;
    out.push({ start: c.start, end: c.end, text: fresh.join('\n') });
  }
  return fixOverlaps(out);
}

function fixOverlaps(cues: Cue[]): Cue[] {
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start)
      cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.end - c.start > 0.01);
}

/** YouTube json3 timedtext. Events carry one caption line each; "\n"-only events are spacers. */
export function parseJson3(json: any): Cue[] {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const cues: Cue[] = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s: any) => s.utf8 || '').join('').replace(/\s*\n\s*/g, '\n').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
  }
  return fixOverlaps(cues);
}

/** YouTube timedtext XML (supports srv3 <p t="ms" d="ms"> and format 1 <text start="s" dur="s">). */
export function parseTimedTextXml(xml: string): Cue[] {
  const cues: Cue[] = [];

  // Try standard DOMParser first if available
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');

      // YouTube srv3 format (<p t="ms" d="ms">...</p>)
      const pElements = doc.querySelectorAll('p');
      if (pElements.length > 0) {
        for (let i = 0; i < pElements.length; i++) {
          const el = pElements[i];
          const t = el.getAttribute('t');
          if (t === null) continue;
          const text = (el.textContent || '').replace(/\s*\n\s*/g, '\n').trim();
          if (!text) continue;
          const start = parseFloat(t) / 1000;
          const dur = el.getAttribute('d') ? parseFloat(el.getAttribute('d')!) / 1000 : 2;
          cues.push({ start, end: start + dur, text });
        }
        if (cues.length > 0) return fixOverlaps(cues);
      }

      // YouTube format 1 (<text start="s" dur="s">...</text>)
      const textElements = doc.querySelectorAll('text');
      if (textElements.length > 0) {
        for (let i = 0; i < textElements.length; i++) {
          const el = textElements[i];
          const startAttr = el.getAttribute('start');
          if (startAttr === null) continue;
          const text = (el.textContent || '').replace(/\s*\n\s*/g, '\n').trim();
          if (!text) continue;
          const start = parseFloat(startAttr);
          const dur = el.getAttribute('dur') ? parseFloat(el.getAttribute('dur')!) : 2;
          cues.push({ start, end: start + dur, text });
        }
        if (cues.length > 0) return fixOverlaps(cues);
      }
    } catch (e) {
      console.warn('DOMParser failed, falling back to regex:', e);
    }
  }

  // Regex fallback: format 3 (<p t="..." d="...">...</p>)
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(xml)) !== null) {
    const attrs = m[1];
    const tMatch = /\bt=["']?(\d+)/.exec(attrs);
    if (!tMatch) continue;
    const dMatch = /\bd=["']?(\d+)/.exec(attrs);
    const start = parseInt(tMatch[1], 10) / 1000;
    const dur = dMatch ? parseInt(dMatch[1], 10) / 1000 : 2;
    const text = stripTags(m[2]).replace(/\s*\n\s*/g, '\n').trim();
    if (text) {
      cues.push({ start, end: start + dur, text });
    }
  }
  if (cues.length > 0) return fixOverlaps(cues);

  // Regex fallback: format 1 (<text start="..." dur="...">...</text>)
  const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  while ((m = textRegex.exec(xml)) !== null) {
    const attrs = m[1];
    const startMatch = /\bstart=["']?([\d.]+)/.exec(attrs);
    if (!startMatch) continue;
    const durMatch = /\bdur=["']?([\d.]+)/.exec(attrs);
    const start = parseFloat(startMatch[1]);
    const dur = durMatch ? parseFloat(durMatch[1]) : 2;
    const text = stripTags(m[2]).replace(/\s*\n\s*/g, '\n').trim();
    if (text) {
      cues.push({ start, end: start + dur, text });
    }
  }

  return fixOverlaps(cues);
}

export function parseSubtitles(text: string, hint: string = ''): Cue[] {
  const t = text.trimStart();
  if (t.startsWith('<?xml') || t.startsWith('<timedtext') || t.startsWith('<transcript')) {
    return parseTimedTextXml(t);
  }
  if (hint === 'json3' || t.startsWith('{')) {
    try {
      return parseJson3(t);
    } catch (e) {
      console.warn('parseJson3 failed, attempting XML parse:', e);
      if (t.includes('<timedtext') || t.includes('<transcript') || t.includes('<p ') || t.includes('<text ')) {
        return parseTimedTextXml(t);
      }
    }
  }
  if (t.includes('<timedtext') || t.includes('<transcript')) {
    return parseTimedTextXml(t);
  }
  return dedupeRolling(parseBlocks(t));
}

export function toSRT(cues: Cue[], offset: number = 0, clipLen: number = Infinity): string {
  let n = 0;
  return cues
    .map((c) => ({ ...c, start: c.start - offset, end: c.end - offset }))
    .filter((c) => c.end > 0 && c.start < clipLen && c.text.trim())
    .map((c) => `${++n}\n${fmtTime(Math.max(0, c.start), ',')} --> ${fmtTime(Math.min(clipLen, c.end), ',')}\n${c.text.trim()}\n`)
    .join('\n');
}

/** Merge neighbouring short cues into readable chunks (joined with spaces; renderer wraps). */
export function autoGroup(cues: Cue[], maxChars: number = 84, maxGap: number = 0.35): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    const text = c.text.replace(/\n/g, ' ');
    if (last && c.start - last.end <= maxGap && last.text.length + 1 + text.length <= maxChars) {
      last.text += ' ' + text;
      last.end = c.end;
    } else {
      out.push({ start: c.start, end: c.end, text });
    }
  }
  return out;
}

/** Capitalise sentence starts and standalone "i". Cheap tidy-up for auto captions. */
export function tidyCase(cues: Cue[]): Cue[] {
  let sentenceStart = true;
  return cues.map((c) => {
    let text = c.text.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|d|ve)\b/gi, (m) => 'I' + m.slice(1));
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, ch) => p + ch.toUpperCase());
    if (sentenceStart)
      text = text.replace(/^([a-z])/, (m) => m.toUpperCase());
    sentenceStart = /[.!?]["')\]]?$/.test(text.trim());
    return { ...c, text };
  });
}
