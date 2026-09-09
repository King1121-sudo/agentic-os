import { resolve } from 'node:path';
const PORT = 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page');
console.log('page url:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
ws.onopen = async () => {
  await send('Page.enable');
  const nav = await send('Page.navigate', { url: 'http://localhost:3000/' });
  console.log('nav:', JSON.stringify(nav).slice(0, 120));
  await new Promise(r => setTimeout(r, 5000));
  const ev = await send('Runtime.evaluate', { expression: 'document.title + " | " + location.href' });
  console.log('eval:', JSON.stringify(ev).slice(0, 300));
  ws.close();
};
