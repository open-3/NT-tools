/**
 * 接收时「更改目录」路径测试：savePath 传入一个目录，验证 normalizeDest 拼上文件名。
 * 复现用户问题 1：选择更改目录后接收方失败。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-lan-dir-'));
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
  chatA.start();
  await new Promise<number>((r) => chatA.once('listening', (p: number) => r(p)));

  const discB = { get: () => undefined, list: () => [] };
  const txB = new TransferService(storeB, chatB, discB);
  chatB.on('frame', (header: any, socket: any) => txB.handleFrame(header, socket));
  const txA = new TransferService(storeA, chatA, { get: () => undefined, list: () => [] });
  chatA.on('frame', (header: any, socket: any) => txA.handleFrame(header, socket));

  const SIZE = 300 * 1024;
  const srcFile = path.join(root, 'dir-test.bin');
  const payload = Buffer.alloc(SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  fs.writeFileSync(srcFile, payload);

  let offer: any = null;
  txB.on('incoming-offer', (o: any) => { offer = o; });
  let doneProgress: any = null;
  let failedProgress: any = null;
  txB.on('progress', (p: any) => {
    if (p.state === 'done') doneProgress = p;
    if (p.state === 'failed') failedProgress = p;
  });

  // 用户「更改目录」选的目录（模拟 pickDir 返回的目录路径）
  const chosenDir = path.join(root, 'my-chosen-dir');
  fs.mkdirSync(chosenDir, { recursive: true });

  const peerB = { id: idB, name: 'hostB', ip: '127.0.0.1', tcpPort: portB, lastSeen: Date.now(), online: true };
  await txA.offer(peerB, srcFile);

  const offerDeadline = Date.now() + 5000;
  while (!offer && Date.now() < offerDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok('收到 incoming-offer', offer !== null);

  // accept 时 savePath 传目录（关键：目录而非完整文件路径）
  txB.accept(offer.transferId, true, chosenDir);

  const deadline = Date.now() + 15000;
  while (!doneProgress && !failedProgress && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  ok('接收完成（非 failed）', doneProgress !== null, `done=${JSON.stringify(doneProgress)} failed=${JSON.stringify(failedProgress)}`);

  // 落盘位置应该是 chosenDir + 文件名
  const dstFile = path.join(chosenDir, 'dir-test.bin');
  ok('文件落在所选目录下', fs.existsSync(dstFile), `dst=${dstFile}`);
  if (fs.existsSync(dstFile)) {
    const got = fs.readFileSync(dstFile);
    ok('字节一致', got.length === payload.length && got.equals(payload), `len=${got.length} eq=${got.equals(payload)}`);
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
