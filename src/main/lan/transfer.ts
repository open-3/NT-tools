import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { downloadsPath } from './env';
import {
  PROTO_VERSION,
  CHUNK_SIZE,
  LanHeader,
  LanFileOffer,
  LanFileAccept,
  LanFileDone,
  encodeFrame,
} from './protocol';
import { LanStore } from './store';
import { PeerInfo } from './discovery';
import { ChatService } from './chat';

/**
 * 文件传输（M2）：TCP 分块流式，256KB 分块，`.part` 临时文件，v1 不做断点续传。
 *
 * 流程：
 *  发送方 offer(peer, filePath) → 连对端 → 发 file-offer（含 transferId）
 *  接收方收到 file-offer → 建 pending 记录 → 若 autoAccept 直接 startReceive，
 *     否则上抛 'incoming-offer' 让 UI 让用户确认
 *  接收方 accept(transferId, ok, savePath) → 发 file-accept → 开始接收
 *  发送方收到 file-accept ok → 流式发字节块（每块 4 字节长度 + 二进制）→ file-done
 *  接收方收完校验字节数 → .part 改名 → done。
 *
 * 字节块不带 JSON 头，靠「accept 之后该 socket 上后续字节全是文件负载」约定。
 * 因 chat 与 transfer 共用 socket，文件传输期间该连接专用于文件（v1 简化：传文件
 * 时不复用同一连接发聊天，聊天走另一条连接或排队）。
 */

interface TransferEvents {
  'progress': [p: TransferProgress];
  'incoming-offer': [offer: IncomingOffer];
}

export interface TransferProgress {
  transferId: number;
  peerId: string;
  dir: 'in' | 'out';
  name: string;
  size: number;
  cur: number;
  state: 'pending' | 'sending' | 'receiving' | 'done' | 'failed';
}

export interface IncomingOffer {
  transferId: number;
  peerId: string;
  peerName: string;
  fileName: string;
  size: number;
  kind: 'file' | 'dir';
}

export class TransferService extends EventEmitter {
  // 活动传输
  private outgoing = new Map<number, { peer: PeerInfo; path: string; size: number }>();
  private incomingRows = new Map<number, { peer: PeerInfo; savePath: string }>();

  constructor(
    private store: LanStore,
    private chat: ChatService,
    private discovery: { get: (id: string) => PeerInfo | undefined; list: () => PeerInfo[] },
  ) {
    super();
  }

  /** 由 chat 的 'frame' 事件驱动文件控制帧 */
  handleFrame(header: LanHeader, socket: net.Socket): void {
    switch (header.type) {
      case 'file-offer':
        this.onOffer(header as LanFileOffer);
        break;
      case 'file-accept':
        this.onAccept(header as LanFileAccept, socket);
        break;
      case 'file-done':
        this.onDone(header as LanFileDone);
        break;
    }
  }

  // ---------- 发送方 ----------

  /** 发送方：向对端发起单文件传输 */
  async offer(peer: PeerInfo, filePath: string): Promise<number> {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const transferId = this.store.addTransfer({
      peerId: peer.id,
      dir: 'out',
      kind: 'file',
      name,
      size: stat.size,
      state: 'pending',
      path: filePath,
      ts: Date.now(),
    });
    this.outgoing.set(transferId, { peer, path: filePath, size: stat.size });

    await new Promise<void>((resolve, reject) => {
      this.chat.getOrConnect(peer, (err, socket) => {
        if (err || !socket) {
          this.store.updateTransfer(transferId, { state: 'failed' });
          return reject(err ?? new Error('连接失败'));
        }
        const offer: LanFileOffer = {
          v: PROTO_VERSION,
          type: 'file-offer',
          id: this.chatId(),
          name: this.chatName(),
          transferId,
          fileName: name,
          size: stat.size,
          kind: 'file',
          ts: Date.now(),
        };
        socket.write(encodeFrame(offer));
        resolve();
      });
    });

    this.emitProgress(transferId, peer.id, 'out', name, stat.size, 0, 'pending');
    return transferId;
  }

  private onAccept(msg: LanFileAccept, socket: net.Socket): void {
    const t = this.outgoing.get(msg.transferId);
    if (!t) return;
    if (!msg.ok) {
      this.store.updateTransfer(msg.transferId, { state: 'failed' });
      this.outgoing.delete(msg.transferId);
      this.emitProgress(msg.transferId, msg.id, 'out', path.basename(t.path), t.size, 0, 'failed');
      return;
    }
    this.sendFileStream(msg.transferId, t);
  }

  private sendFileStream(transferId: number, t: { peer: PeerInfo; path: string; size: number }): void {
    const name = path.basename(t.path);
    const socket = this.chat.getConnections().get(t.peer.id);
    if (!socket) {
      this.store.updateTransfer(transferId, { state: 'failed' });
      return;
    }
    const rs = fs.createReadStream(t.path, { highWaterMark: CHUNK_SIZE });
    let sent = 0;

    rs.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const len = Buffer.allocUnsafe(4);
      len.writeUInt32BE(buf.length, 0);
      socket.write(Buffer.concat([len, buf]));
      sent += buf.length;
      this.store.updateTransfer(transferId, { size: sent });
      this.emitProgress(transferId, t.peer.id, 'out', name, t.size, sent, 'sending');
    });
    rs.on('end', () => {
      const done: LanFileDone = {
        v: PROTO_VERSION,
        type: 'file-done',
        id: this.chatId(),
        name: this.chatName(),
        transferId,
        ok: true,
      };
      socket.write(encodeFrame(done));
      this.store.updateTransfer(transferId, { state: 'done' });
      this.emitProgress(transferId, t.peer.id, 'out', name, t.size, sent, 'done');
      this.outgoing.delete(transferId);
    });
    rs.on('error', (err) => {
      this.store.updateTransfer(transferId, { state: 'failed' });
      this.emitProgress(transferId, t.peer.id, 'out', name, t.size, sent, 'failed');
      this.outgoing.delete(transferId);
    });
  }

  private onDone(msg: LanFileDone): void {
    // 发送方收到接收方的 file-done 确认（v1 单文件可忽略）
    void msg;
  }

  // ---------- 接收方 ----------

  private onOffer(msg: LanFileOffer): void {
    const peer = this.discovery.get(msg.id);
    if (!peer) return;
    // 建接收 pending 记录
    this.store.addTransfer({
      peerId: msg.id,
      dir: 'in',
      kind: msg.kind,
      name: msg.fileName,
      size: msg.size,
      state: 'pending',
      path: '',
      ts: Date.now(),
    });
    this.incomingRows.set(msg.transferId, { peer, savePath: '' });

    const offer: IncomingOffer = {
      transferId: msg.transferId,
      peerId: msg.id,
      peerName: msg.name,
      fileName: msg.fileName,
      size: msg.size,
      kind: msg.kind,
    };

    // 记住了直接接收，否则让用户确认
    if (this.store.isAutoAccept(msg.id)) {
      const savePath = path.join(this.defaultSaveDir(), msg.fileName);
      this.accept(msg.transferId, true, savePath);
    } else {
      this.emit('incoming-offer', offer);
    }
  }

  /** 接收方：应答并开始接收 */
  accept(transferId: number, ok: boolean, savePath?: string): void {
    const row = this.incomingRows.get(transferId);
    if (!row) return;
    const socket = this.chat.getConnections().get(row.peer.id);

    const reply: LanFileAccept = {
      v: PROTO_VERSION,
      type: 'file-accept',
      id: this.chatId(),
      name: this.chatName(),
      transferId,
      ok,
      reason: ok ? undefined : '用户拒绝',
    };
    socket?.write(encodeFrame(reply));

    if (ok && savePath && socket) {
      this.beginReceive(transferId, row.peer, savePath, socket);
    }
  }

  private beginReceive(transferId: number, peer: PeerInfo, savePath: string, socket: net.Socket): void {
    this.incomingRows.set(transferId, { peer, savePath });
    const size = this.incomingSize(transferId);
    const partPath = savePath + '.part';
    const ws = fs.createWriteStream(partPath);
    let received = 0;
    let buf = Buffer.alloc(0);

    // 文件传输期间该连接专用于文件：摘除 chat 的帧解析器，避免原始字节被当帧解析
    this.chat.pauseFrames(socket);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const block = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        received += block.length;
        ws.write(block); // 背压交由 Node 内部缓冲（v1 简化）
        this.store.updateTransfer(transferId, { size: received });
        this.emitProgress(transferId, peer.id, 'in', path.basename(savePath), size, received, 'receiving');
        if (received >= size) {
          finish(true);
          return;
        }
      }
    };

    const finish = (ok: boolean) => {
      socket.off('data', onData);
      this.chat.resumeFrames(socket);
      ws.end(() => {
        if (ok) {
          try {
            if (fs.existsSync(partPath)) fs.renameSync(partPath, savePath);
            this.store.updateTransfer(transferId, { state: 'done', path: savePath });
            this.emitProgress(transferId, peer.id, 'in', path.basename(savePath), size, received, 'done');
          } catch {
            this.store.updateTransfer(transferId, { state: 'failed' });
            this.emitProgress(transferId, peer.id, 'in', path.basename(savePath), size, received, 'failed');
          }
        } else {
          try {
            fs.rmSync(partPath, { force: true });
          } catch {
            /* ignore */
          }
          this.store.updateTransfer(transferId, { state: 'failed' });
          this.emitProgress(transferId, peer.id, 'in', path.basename(savePath), size, received, 'failed');
        }
        this.incomingRows.delete(transferId);
      });
    };

    socket.on('data', onData);
    socket.once('close', () => {
      if (received < size) finish(false);
    });
  }

  private incomingSize(transferId: number): number {
    const rows = this.store.getRecentTransfers(200);
    const row = rows.find((r) => r.id === transferId);
    return row?.size ?? 0;
  }

  private defaultSaveDir(): string {
    const dir = path.join(downloadsPath(), 'AgentPulse');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    return dir;
  }

  private chatId(): string {
    return (this.chat as any).selfId;
  }
  private chatName(): string {
    return (this.chat as any).selfName;
  }

  private emitProgress(
    transferId: number,
    peerId: string,
    dir: 'in' | 'out',
    name: string,
    size: number,
    cur: number,
    state: TransferProgress['state'],
  ): void {
    this.emit('progress', { transferId, peerId, dir, name, size, cur, state } satisfies TransferProgress);
  }

  stop(): void {
    this.outgoing.clear();
    this.incomingRows.clear();
  }
}
