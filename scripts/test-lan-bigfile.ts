/**
 * 大文件传输端到端复现：8.5MB（33 块），模拟真实用户失败场景。
 *
 * 关键差异 vs test-lan-transfer-e2e.ts：
 *  - 8.5MB 跨 33 个 256KB 块
 *  - 非 autoAccept：模拟"用户看到弹窗 → 点接收"的延迟路径
 *    （onOffer → emit incoming-offer → 延迟 → accept(senderTransferId, true, undefined)）
 *    savePath 传 undefined，验证兜底默认路径。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-lan-big-'));
  process.env.AGENT_PULSE_LAN_ID_DIR = root;
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'a.db');
  process.env.AGENT_PULSE_DOWNLOAD_DIR = path.join(root, 'dl');
  process.env.AGENT_PULSE_LAN_LOOPBACK = '1';

  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${detail}`); }
  };

  const { LanStore } = await import('../src/main/lan/store');
  const { ChatService } = await import('../src/main/lan/chat');
  const { TransferService } = await import('../src/main/lan/transfer');

  const idA = randomUUID();
  const idB = randomUUID();

  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'a.db');
  const storeA = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'b.db');
  const storeB = new LanStore();

  const chatA = new ChatService(storeA, idA, 'hostA');
  const chatB = new ChatService(storeB, idB, 'hostB');
  chatB.start();
  const portB = await new Promise<number>((r) => chatB.once('listening', (p: number) => r(p)));
  // A 也要 start 才能有 tcpPort（虽然发送方主要是主动连接，但 hello 需要端口）
  chatA.start();
  await new Promise<number>((r) => chatA.once('listening', (p: number) => r(p)));

  const peerA = { id: idA, name: 'hostA', ip: '127.0.0.1', tcpPort: 0, lastSeen: Date.now(), online: true };
  const discB = { get: (id: string) => (id === idA ? peerA : undefined), list: () => [peerA] };
  const txB = new TransferService(storeB, chatB, discB);
  chatB.on('frame', (header: any, socket: any) => txB.handleFrame(header, socket));

  const txA = new TransferService(storeA, chatA, { get: () => undefined, list: () => [] });
  chatA.on('frame', (header: any, socket: any) => txA.handleFrame(header, socket));

  // 8.5MB 文件
  const srcFile = path.join(root, 'big.bin');
  const SIZE = 8527067;
  const payload = Buffer.alloc(SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) & 0xff;
  fs.writeFileSync(srcFile, payload);

  // 非 autoAccept：B 收到 offer 后，等 incoming-offer 事件，延迟后 accept（savePath=undefined）
  let offer: any = null;
  txB.on('incoming-offer', (o: any) => { offer = o; });
  let doneProgress: any = null;
  let failedProgress: any = null;
  txB.on('progress', (p: any) => {
    if (p.state === 'done') doneProgress = p;
    if (p.state === 'failed') failedProgress = p;
  });

  const peerB = { id: idB, name: 'hostB', ip: '127.0.0.1', tcpPort: portB, lastSeen: Date.now(), online: true };
  const transferId = await txA.offer(peerB, srcFile);

  // 等 offer 到达
  const offerDeadline = Date.now() + 5000;
  while (!offer && Date.now() < offerDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok('接收方收到 incoming-offer', offer !== null, JSON.stringify(offer));

  // 模拟用户延迟 2 秒后点「接收」，savePath 传 undefined（兜底默认路径）
  await new Promise((r) => setTimeout(r, 2000));
  txB.accept(offer.transferId, true, undefined);

  const deadline = Date.now() + 15000;
  while (!doneProgress && !failedProgress && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  ok('接收方完成（非 failed）', doneProgress !== null, `done=${JSON.stringify(doneProgress)} failed=${JSON.stringify(failedProgress)}`);

  const dstFile = path.join(root, 'dl', 'AgentPulse', 'big.bin');
  ok('接收方落盘文件存在', fs.existsSync(dstFile));
  if (fs.existsSync(dstFile)) {
    const got = fs.readFileSync(dstFile);
    ok('字节一致（8.5MB/33块）', got.length === payload.length && got.equals(payload), `len=${got.length} eq=${got.equals(payload)}`);
  }

  chatA.stop();
  chatB.stop();
  storeA.close();
  storeB.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
