import { app, BrowserWindow } from 'electron';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 8765;
const FORMAT = "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][vcodec^=avc1][acodec^=mp4a]/bv*[height<=720]+ba/b[height<=720]/b";

let urlHeaders: Record<string, any> = {};

function pickCaption(entries: any[]) {
  const byExt = Object.fromEntries(entries.map((e) => [e.ext, e]));
  return byExt.json3 || byExt.vtt || byExt.srt;
}

function resolveYtDlp(targetUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '-f', FORMAT, targetUrl]);
    let out = '';
    let err = '';
    ytdlp.stdout.on('data', d => out += d);
    ytdlp.stderr.on('data', d => err += d);
    ytdlp.on('close', code => {
      if (code !== 0) {
        const lines = err.trim().split('\n');
        return reject(new Error(lines[lines.length - 1] || 'yt-dlp failed'));
      }
      try {
        const info = JSON.parse(out);
        const req = info.requested_formats || [info];
        const video = req.find((f: any) => f.vcodec && f.vcodec !== 'none') || req[0];
        const audio = req.find((f: any) => f !== video && f.acodec && f.acodec !== 'none');

        const stream = (f: any) => {
          urlHeaders[f.url] = f.http_headers || {};
          return {
            url: f.url, ext: f.ext, vcodec: f.vcodec, acodec: f.acodec,
            size: f.filesize || f.filesize_approx, height: f.height
          };
        };

        const captions: any[] = [];
        for (const [lang, entries] of Object.entries(info.subtitles || {})) {
          const c = pickCaption(entries as any[]);
          if (c && lang !== 'live_chat') {
            captions.push({ lang, name: c.name || lang, auto: false, ext: c.ext, url: c.url });
          }
        }
        for (const [lang, entries] of Object.entries(info.automatic_captions || {})) {
          if (!lang.endsWith('-orig') && !['en', 'en-US', 'en-GB'].includes(lang)) continue;
          const c = pickCaption(entries as any[]);
          if (c) {
            captions.push({ lang, name: (c.name || lang) + ' (auto)', auto: true, ext: c.ext, url: c.url });
          }
        }
        captions.sort((a, b) => (a.auto === b.auto ? 0 : a.auto ? 1 : -1) || (a.lang.startsWith('en') ? -1 : 1) || a.lang.localeCompare(b.lang));

        resolve({
          id: info.id, title: info.title, duration: info.duration, thumbnail: info.thumbnail,
          video: stream(video), audio: audio ? stream(audio) : null, captions
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '', true);
  
  if (parsed.pathname === '/api/resolve') {
    const targetUrl = Array.isArray(parsed.query.url) ? parsed.query.url[0] : parsed.query.url;
    if (!targetUrl) return res.writeHead(400).end(JSON.stringify({ error: 'url required' }));
    resolveYtDlp(targetUrl).then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  
  if (parsed.pathname === '/api/fetch') {
    const targetUrl = Array.isArray(parsed.query.url) ? parsed.query.url[0] : parsed.query.url;
    if (!targetUrl) return res.writeHead(400).end(JSON.stringify({ error: 'url required' }));
    
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...urlHeaders[targetUrl] };
    if (req.headers.range) headers['Range'] = req.headers.range;
    
    const proxyReq = https.request(targetUrl, { headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502).end(JSON.stringify({ error: e.message }));
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // Serve static files
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname || '';
  let fullPath = path.join(__dirname, '../src', filePath);
  if (filePath.endsWith('.js') && !fs.existsSync(fullPath)) {
    // If asking for app.js but we compiled to dist/src/app.js
    fullPath = path.join(__dirname, 'src', filePath);
  }
  
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Try again in root src directory in case we are in dev
      fullPath = path.join(__dirname, '..', 'src', filePath);
      fs.readFile(fullPath, (err2, data2) => {
        if (err2) {
            res.writeHead(404);
            res.end(JSON.stringify(err2));
            return;
        }
        const ext = path.extname(fullPath);
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    res.end(data);
  });
});

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    win.loadURL(`http://127.0.0.1:${PORT}`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
