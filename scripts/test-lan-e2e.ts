/**
 * 局域网通信 e2e：验证协议帧编解码、存储、TCP 聊天（定向 + 广播）、UDP 组播发现。
 *
 * 纯 Node 运行，electron 依赖用 env 覆盖绕过：
 *  - AGENT_PULSE_LAN_DB / AGENT_PULSE_LAN_ID_DIR 指向临时目录
 *  - 直接测底层组件：Protocol、LanStore、ChatService（真实 TCP 回环）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeFrame, tryParseHeader, encodeChunk } from '../src/main/lan/protocol';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-lan-'));
  process.env.AGENT_PULSE_LAN_ID_DIR = root;
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');
  // 同机双实例测试需开启组播回环才能互见（生产环境默认禁用以避免自识别）
  process.env.AGENT_PULSE_LAN_LOOPBACK = '1';

  // 设好 env 后再导入依赖 electron 的模块
  const { LanStore } = await import('../src/main/lan/store');
  const { Discovery, primaryIp } = await import('../src/main/lan/discovery');
  const { ChatService } = await import('../src/main/lan/chat');

  // ---------- 1) 协议帧编解码 ----------
  const msg = { v: 1, type: 'chat' as const, id: 'a', name: 'b', text: '你好世界', ts: 123, kind: 'text' as const };
  const frame = encodeFrame(msg);
  ok('encodeFrame 产出长度前缀', frame.readUInt32BE(0) === Buffer.byteLength(JSON.stringify(msg), 'utf8'));
  const parsed = tryParseHeader(frame);
  ok('tryParseHeader 还原', parsed !== null && parsed.header.text === '你好世界');
  ok('tryParseHeader 不足返回 null', tryParseHeader(Buffer.from([0, 0, 0, 10])) === null);

  const chunk = encodeChunk(Buffer.from([1, 2, 3, 4, 5]));
  ok('encodeChunk 长度=5', chunk.readUInt32BE(0) === 5);

  const big = Buffer.allocUnsafe(4);
  big.writeUInt32BE(1 << 20, 0);
  let threw = false;
  try {
    tryParseHeader(big);
  } catch {
    threw = true;
  }
  ok('超长帧头抛错', threw);

  // ---------- 2) 存储 ----------
  const store = new LanStore();
  store.addMessage({ peerId: 'p1', dir: 'in', kind: 'text', text: 'hello', meta: '', ts: 1000 });
  store.addMessage({ peerId: 'p1', dir: 'out', kind: 'text', text: 'hi', meta: '', ts: 2000 });
  store.addMessage({ peerId: 'p1', dir: 'in', kind: 'broadcast', text: '广播', meta: '', ts: 3000 });
  const msgs = store.getMessages('p1');
  ok('getMessages 降序 3 条', msgs.length === 3 && msgs[0].ts === 3000 && msgs[2].ts === 1000, JSON.stringify(msgs));

  store.setAutoAccept('p2', true);
  ok('isAutoAccept 记住', store.isAutoAccept('p2') === true);
  const tid = store.addTransfer({ peerId: 'p2', dir: 'out', kind: 'file', name: 'a.txt', size: 10, state: 'pending', path: 'x', ts: 1 });
  store.updateTransfer(tid, { state: 'done', path: 'y' });
  const tr = store.getRecentTransfers();
  ok('transfer 更新', tr.length === 1 && tr[0].state === 'done' && tr[0].path === 'y');
  store.close();

  // ---------- 3) TCP 定向聊天 + 广播 ----------
  const idA = randomUUID();
  const idB = randomUUID();

  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');
  const storeA = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan-b.db');
  const storeB = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');

  const chatA = new ChatService(storeA, idA, 'hostA');
  const chatB = new ChatService(storeB, idB, 'hostB');

  chatB.start();
  const portB = await new Promise<number>((resolve) => chatB.once('listening', (p: number) => resolve(p)));
  ok('B 监听拿到端口', portB > 0);

  let gotA = false;
  let gotBroadcast = false;
  chatB.on('message', (m: any) => {
    if (m.text === 'ping-from-A') gotA = true;
    if (m.kind === 'broadcast') gotBroadcast = true;
  });

  const peerB = { id: idB, name: 'hostB', ip: '127.0.0.1', tcpPort: portB, lastSeen: Date.now(), online: true };
  await chatA.sendChat(peerB, 'ping-from-A', 'text');
  await new Promise((r) => setTimeout(r, 500));
  ok('TCP 定向聊天 A→B 送达', gotA);
  ok('storeB 入库 in 消息', storeB.getMessages(idA).length >= 1);
  ok('storeA 入库 out 消息', storeA.getMessages(idB).length === 1);

  // 广播：A 侧走独立连接发广播帧，B 收到（kind='broadcast'）
  await chatA.broadcast('大家好', [peerB]);
  await new Promise((r) => setTimeout(r, 500));
  ok('广播送达', gotBroadcast, 'storeB msgs=' + JSON.stringify(storeB.getMessages(idA).map((m) => [m.kind, m.text])));

  chatA.stop();
  chatB.stop();

  // ---------- 3b) 长文本（跨多个 TCP 包）定向聊天 ----------
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');
  const storeA3 = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan-b3.db');
  const storeB3 = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');

  const chatA3 = new ChatService(storeA3, idA, 'hostA');
  const chatB3 = new ChatService(storeB3, idB, 'hostB');
  chatB3.start();
  const portB3 = await new Promise<number>((resolve) => chatB3.once('listening', (p: number) => resolve(p)));

  // 构造一段约 12KB 的长文本（超过典型单次 TCP 段，会被拆成多包；远小于 64KB 帧头上限）
  const longText = 'package com.demo; // 长文本测试\n' + 'x'.repeat(12 * 1024);
  let gotLong = '';
  chatB3.on('message', (m: any) => {
    if (m.text.startsWith('package com.demo;')) gotLong = m.text;
  });

  const peerB3 = { id: idB, name: 'hostB', ip: '127.0.0.1', tcpPort: portB3, lastSeen: Date.now(), online: true };
  await chatA3.sendChat(peerB3, longText, 'text');
  await new Promise((r) => setTimeout(r, 800));
  ok('长文本（12KB，跨多包）完整送达', gotLong === longText, `收到长度=${gotLong.length}/${longText.length}`);

  chatA3.stop();
  chatB3.stop();
  storeA3.close();
  storeB3.close();
  storeA.close();
  storeB.close();

  // ---------- 4) UDP 组播发现（同机双实例回环） ----------
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan-a2.db');
  const storeA2 = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan-b2.db');
  const storeB2 = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'lan.db');

  const idSend = randomUUID();
  const idRecv = randomUUID();

  const discSend = new Discovery(storeA2, 10001, idSend, 'sender');
  const discRecv = new Discovery(storeB2, 10002, idRecv, 'receiver');

  let discovered = false;
  discRecv.onChange(() => {
    if (discRecv.list().some((p) => p.id === idSend && p.online)) discovered = true;
  });

  discRecv.start();
  await new Promise((r) => setTimeout(r, 300));
  discSend.start();
  await new Promise((r) => setTimeout(r, 4200));

  const saw = discRecv.list().map((p) => `${p.id.slice(0, 8)}@${p.ip}:${p.tcpPort} on=${p.online}`);
  ok('UDP 组播发现互见', discovered, JSON.stringify(saw));

  discSend.stop();
  discRecv.stop();
  storeA2.close();
  storeB2.close();

  ok('primaryIp 非空', (primaryIp() ?? '').length > 0, primaryIp());

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
