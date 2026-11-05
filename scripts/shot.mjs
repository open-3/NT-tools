/**
 * 用 CDP 截图当前 Electron 页面。
 * 用法：node scripts/shot.mjs <port> <out.png>
 */
import * as fs from 'node:fs';

const port = process.argv[2] || '9555';
const out = process.argv[3] || 'shot.png';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    setTimeout(() => reject(new Error('timeout ' + method)), 15000);
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(0);
