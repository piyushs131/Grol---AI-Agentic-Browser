#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(BROWSER, 'resources', 'logo');
const ring = readFileSync(join(BROWSER, 'agent-extension', 'logo.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const solid = (color) => ring.replace(/stroke="url\(#ring\)"/, `stroke="${color}"`);
const wordmark = (svg, color) => `<div style="display:flex;align-items:center;gap:0.18em;height:100%;font:600 150px -apple-system,'Helvetica Neue',sans-serif;color:${color}">
  <div style="width:176px;height:176px">${svg}</div><span style="letter-spacing:-0.02em">Grol</span></div>`;
const square = (svg) => `<div style="width:1024px;height:1024px">${svg}</div>`;

const MASTERS = [
  { file: 'logo.png', html: square(ring), width: 1024, height: 1024 },
  { file: 'logo-white.png', html: square(solid('#ffffff')), width: 1024, height: 1024 },
  { file: 'logo-mono.png', html: square(solid('#000000')), width: 1024, height: 1024 },
  { file: 'wordmark.png', html: wordmark(ring, '#1f1f1f'), width: 560, height: 176 },
  { file: 'wordmark-white.png', html: wordmark(solid('#ffffff'), '#ffffff'), width: 560, height: 176 }
];

const profile = mkdtempSync(join(tmpdir(), 'grol-logo-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await new Promise((r) => setTimeout(r, 200));
    page = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((t) => t.find((x) => x.type === 'page')).catch(() => null);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const m of MASTERS) {
    await send('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: 1, mobile: false });
    const html = `<!doctype html><html><body style="margin:0;background:transparent">${m.html}</body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: m.width, height: m.height, scale: 1 } });
    writeFileSync(join(OUT, m.file), Buffer.from(data, 'base64'));
    console.log(`✓ resources/logo/${m.file} (${m.width}x${m.height})`);
  }
  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
