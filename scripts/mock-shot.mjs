/**
 * 出视觉稿：注入假快照 + 冻结轮询 + 截图，一步完成。
 * 用法：node scripts/mock-shot.mjs <port> <snapshot.json> <out.png>
 */
import * as fs from 'node:fs';

const [port, snapFile, out] = process.argv.slice(2);

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

const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
const expr = `(() => {
  window.__pulseFreeze(true);
  window.__pulsePaint(${JSON.stringify(snap)});
  return 'painted';
})()`;
await send('Runtime.evaluate', { expression: expr, returnByValue: true });

// 等布局稳定（syncHeight 走 rAF），然后截图
await new Promise((r) => setTimeout(r, 350));

const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    h: innerHeight,
    foot: document.querySelector('.p-foot')?.innerText.replace(/\\n/g,'|'),
    tok: document.querySelector('.tok')?.textContent,
    hot: document.querySelector('.quota-hot')?.textContent,
    overflow: document.body.scrollHeight > innerHeight
  })`,
  returnByValue: true,
});
console.log(info.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(0);
