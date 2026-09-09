#!/usr/bin/env node
/**
 * Headless Chrome screenshot harness via raw CDP (no puppeteer dep).
 * Usage:
 *   node shot.mjs login                                # authenticate (stores nothing; cookie persists in profile)
 *   node shot.mjs shot <url-path> <name> [w] [h]       # capture page at viewport
 *   node shot.mjs run <manifest.json>                  # batch capture
 * Cookies persist in ./chrome-profile so login once is enough.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = resolve(process.argv[1] ?? '.', '../../shots');
const PROFILE = resolve(process.argv[1] ?? '.', '../../chrome-profile');
const USER = process.env.OS_USER || 'admin';
const PASS = process.env.OS_PASS || 'admin123';
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureChrome() {
  // is it up?
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) return;
  } catch {}
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
  }
  throw new Error('chrome did not start');
}

async function getPageWs() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => res({
      send(method, params = {}) {
        return new Promise((r2, rj2) => {
          const mid = ++id;
          pending.set(mid, { r2, rj2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id).r2(d); pending.delete(d.id); }
    };
    ws.onerror = (e) => rej(e);
  });
}

const [, , cmd, ...rest] = process.argv;

if (cmd === 'login') {
  await ensureChrome();
  const ws = await wsConnect(await getPageWs());
  await ws.send('Page.enable');
  await ws.send('Page.navigate', { url: `${BASE}/login` });
  await sleep(2500);
  const evalRes = await ws.send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:'${USER}', password:'${PASS}'}) });
      return r.status + ' ' + (await r.text()).slice(0,100);
    })()`,
  });
  console.log('login:', evalRes.result?.value);
  ws.close();
} else if (cmd === 'shot') {
  const [path, name, w = 1600, h = 1000, waitMs = 3000] = rest;
  await ensureChrome();
  const ws = await wsConnect(await getPageWs());
  await ws.send('Page.enable');
  await ws.send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 820 });
  await ws.send('Page.navigate', { url: `${BASE}${path}` });
  await sleep(+waitMs);
  const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  // also grab rendered text for grounding
  const txt = await ws.send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 2000)' });
  console.log(`saved: ${file}`);
  console.log('--- text ---');
  console.log(txt.result?.value?.slice(0, 1500));
  ws.close();
} else if (cmd === 'qa') {
  // DOM-based QA: navigate, wait, extract computed metrics for design-system compliance
  const [path, name, w = 1600, h = 1000, waitMs = 4000] = rest;
  await ensureChrome();
  const ws = await wsConnect(await getPageWs());
  await ws.send('Page.enable');
  await ws.send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 820 });
  await ws.send('Page.navigate', { url: `${BASE}${path}` });
  await sleep(+waitMs);
  const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
  const qa = await ws.send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => { try {
      const out = { url: location.href, title: document.title, issues: [], stats: {} };
      const doc = document.documentElement;
      out.stats.viewport = { w: innerWidth, h: innerHeight };
      // horizontal overflow
      if (doc.scrollWidth > doc.clientWidth + 1) out.issues.push('h-overflow: ' + (doc.scrollWidth - doc.clientWidth) + 'px');
      // failing links / empty sections
      document.querySelectorAll('a[href]').forEach(a => {
        const r = a.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return; // hidden ok
      });
      // buttons without accessible name
      document.querySelectorAll('button').forEach(b => {
        if (!b.textContent.trim() && !b.getAttribute('aria-label') && !b.title) out.issues.push('button-no-name: ' + b.className);
      });
      // tiny text
      const sizes = {};
      document.querySelectorAll('body *').forEach(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim()).length;
        if (!own) return;
        const cs = getComputedStyle(el);
        const px = cs.fontSize;
        sizes[px] = (sizes[px] || 0) + 1;
        if (parseFloat(px) < 9) out.issues.push('tiny-text: ' + px + ' <' + el.tagName + '.' + el.className + '> ' + el.textContent.trim().slice(0, 30));
      });
      out.stats.fontSizes = sizes;
      // images without alt
      document.querySelectorAll('img').forEach(i => { if (!i.alt) out.issues.push('img-no-alt'); });
      // focus visibility probe
      const f = document.createElement('button'); f.textContent = 'probe'; f.style.position='fixed'; f.style.left='-9999px'; document.body.appendChild(f);
      f.focus();
      const fc = getComputedStyle(f);
      out.stats.probeFocus = { outline: fc.outlineStyle !== 'none', boxShadow: fc.boxShadow !== 'none' };
      f.remove();
      // summary of visible headings hierarchy
      out.stats.headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 20).map(x => x.tagName + ':' + x.textContent.trim().slice(0, 40));
      // panel count / nav
      out.stats.nav = Array.from(document.querySelectorAll('.rail a, nav a')).map(a => a.textContent.trim() + '=' + (a.className.includes('on') ? 'ACTIVE' : '-')).slice(0, 20);
      // empty states visible
      out.stats.empties = Array.from(document.querySelectorAll('.empty')).map(e => e.textContent.trim().slice(0, 60));
      return JSON.stringify(out);
    } catch (err) { return JSON.stringify({ fatal: String(err) }); } })()`,
  });
  try { console.log(JSON.parse(qa.result.value)); } catch { console.log(qa.result.value); }
  ws.close();
} else {
  console.log('unknown cmd');
}
