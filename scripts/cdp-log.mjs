/**
 * 连到 Electron 页面，开启 Log/Runtime 域，收集若干秒内的 console 与异常。
 * 用法：node scripts/cdp-log.mjs <port> [seconds]
 */
const port = process.argv[2] || '9555';
const seconds = Number(process.argv[3] || 6);

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

const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    events.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    events.push('[exception] ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  } else if (msg.method === 'Log.entryAdded') {
    events.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');

await new Promise((r) => setTimeout(r, seconds * 1000));

console.log(events.length ? events.join('\n') : `(no console/log output in ${seconds}s)`);
ws.close();
process.exit(0);
