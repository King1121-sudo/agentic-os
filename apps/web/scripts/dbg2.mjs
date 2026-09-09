// QA same as shot.mjs but prints raw CDP response for diagnosis
const PORT = 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => rej(new Error('timeout ' + method)), 20000); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.onopen = async () => {
  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(5000);
    const ev = await send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => { try {
        return JSON.stringify({ title: document.title, len: document.body.innerText.length, txt: document.body.innerText.slice(0, 200) });
      } catch (err) { return JSON.stringify({ fatal: String(err) }); } })()`,
    });
    console.log('RAW:', JSON.stringify(ev).slice(0, 800));
    ws.close();
    process.exit(0);
  } catch (e) { console.log('ERR:', e.message); process.exit(1); }
};
