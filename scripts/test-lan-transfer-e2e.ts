/**
 * 局域网通信 M2：文件传输端到端（真实 TCP 回环）。
 *
 * 流程：发送方 offer → 接收方收到 file-offer（autoAccept 直接 accept）→
 *       发送方流式发字节块 → 接收方按字节数判定完成 → 字节一致。
 *
 * 纯 Node 运行（electron 路径用 env 覆盖绕过，见 src/main/lan/env.ts）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-lan-tx-'));
  process.env.AGENT_PULSE_LAN_ID_DIR = root;
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'a.db');
  process.env.AGENT_PULSE_DOWNLOAD_DIR = path.join(root, 'dl');
  process.env.AGENT_PULSE_LAN_LOOPBACK = '1';

  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean, detail = ''): void => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.log(`  ✗ ${name} ${detail}`);
    }
  };

  const { LanStore } = await import('../src/main/lan/store');
  const { Discovery } = await import('../src/main/lan/discovery');
  const { ChatService } = await import('../src/main/lan/chat');
  const { TransferService } = await import('../src/main/lan/transfer');

  const idA = randomUUID();
  const idB = randomUUID();

  // 独立 DB
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'a.db');
  const storeA = new LanStore();
  process.env.AGENT_PULSE_LAN_DB = path.join(root, 'b.db');
  const storeB = new LanStore();

  const chatA = new ChatService(storeA, idA, 'hostA');
  const chatB = new ChatService(storeB, idB, 'hostB');
  chatB.start();
  const portB = await new Promise<number>((r) => chatB.once('listening', (p: number) => r(p)));

  // discovery 桩：B 知道 A（用于接收方 peer 查找）
  const peerA = { id: idA, name: 'hostA', ip: '127.0.0.1', tcpPort: 0, lastSeen: Date.now(), online: true };
  const discB = { get: (id: string) => (id === idA ? peerA : undefined), list: () => [peerA] };

  // B 的 TransferService 需要知道自己的 identity；通过 chat 传入
  const txB = new TransferService(storeB, chatB, discB);
  // B 端 chat 的 frame 事件驱动接收
  chatB.on('frame', (header: any, socket: any) => txB.handleFrame(header, socket));

  // A 端：chatA + txA（发送方不需要 discovery 查 peer，传空桩）
  const chatAStarted = chatA;
  const txA = new TransferService(storeA, chatA, { get: () => undefined, list: () => [] });
  chatA.on('frame', (header: any, socket: any) => txA.handleFrame(header, socket));

  // 造一个 600KB 的测试文件（> CHUNK_SIZE=256KB，跨多块）
  const srcFile = path.join(root, 'payload.bin');
  const payload = Buffer.alloc(600 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  fs.writeFileSync(srcFile, payload);

  // B 记住 A，直接接收（autoAccept）
  storeB.setAutoAccept(idA, true);

  // B 收到 file-offer 会自动 accept 并开始接收
  let doneProgress: any = null;
  txB.on('progress', (p: any) => {
    if (p.state === 'done') doneProgress = p;
  });

  // A 发起 offer（A 需要连到 B 的端口）
  const peerB = { id: idB, name: 'hostB', ip: '127.0.0.1', tcpPort: portB, lastSeen: Date.now(), online: true };
  // A 端发起前，把 B 的 id 对应的 socket 建立起来（offer 内部 getOrConnect）
  const transferId = await txA.offer(peerB, srcFile);

  // 等待接收完成（轮询 doneProgress，最多 10s）
  const deadline = Date.now() + 10000;
  while (!doneProgress && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  ok('发送方产生 transferId', transferId > 0);
  ok('接收方收到完成事件', doneProgress !== null, JSON.stringify(doneProgress));

  const dstFile = path.join(root, 'dl', 'AgentPulse', 'payload.bin');
  ok('接收方落盘文件存在', fs.existsSync(dstFile));

  if (fs.existsSync(dstFile)) {
    const got = fs.readFileSync(dstFile);
    ok('字节一致（600KB）', got.length === payload.length && got.equals(payload), `len=${got.length} eq=${got.equals(payload)}`);
  }

  // 清理
  chatA.stop();
  chatB.stop();
  storeA.close();
  storeB.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
