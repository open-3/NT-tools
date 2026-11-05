/**
 * 极简 CDP 客户端：连到已启动的 Electron 页面，执行一段表达式并打印结果。
 * 用法：node scripts/cdp.mjs <port> <expression-file-or-inline>
 */
const port = process.argv[2] || '9555';
const expr = process.argv[3] || 'document.body.innerText';

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

const res = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
ws.close();
process.exit(0);
