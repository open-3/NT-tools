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
 *  发送方 offer(peer, filePath) → 连对端 → 发 file-offer（含发送方本地 transferId）
 *  接收方收到 file-offer → 建本地 pending 记录（本地另有 transferId）→
 *     若 autoAccept 直接接收，否则上抛 'incoming-offer' 让 UI 确认
 *  接收方 accept(senderTransferId, ok, savePath) → 发 file-accept（回 senderTransferId）→ 开始接收
 *  发送方收到 file-accept ok → 流式发字节块（每块 4 字节长度 + 二进制）
 *  接收方按字节数 received>=size 判定完成 → .part 改名 → done。
 *
 * 关键约定：
 *  - 「transferId」是发送方本地自增 id，跨端仅作关联键；接收方自身另有本地 id，
 *    进度/落盘统一用本地 id，size 取自 file-offer 的 msg.size（不再反查表，避免撞 id）。
 *  - 接收方不依赖 discovery 查找发送方（组播 3s 心跳有延迟，TCP 先到时可能查不到）：
 *    peer 元数据（id/name）直接取自 file-offer 帧，socket 取自 handleFrame 传入参数。
 *  - 字节块不带 JSON 头，靠「accept 之后该 socket 上后续字节全是文件负载」约定；
 *    chat 与 transfer 共用 socket，文件传输期间该连接专用于文件。
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
  transferId: number; // 发送方的 transferId（关联 acceptFile）
  peerId: string;
  peerName: string;
  fileName: string;
  size: number;
  kind: 'file' | 'dir';
}

interface OutgoingRow {
  peer: PeerInfo;
  path: string;
  size: number;
}

interface IncomingRow {
  peer: PeerInfo;
  savePath: string;
  /** 文件名（取自 file-offer 的 fileName，用于兜底默认保存路径） */
  fileName: string;
  /** 接收方本地 transfer 记录 id（用于进度/落盘，区别于发送方 transferId） */
  localTransferId: number;
  /** 文件总大小（取自 file-offer 的 size 字段） */
  size: number;
}

export class TransferService extends EventEmitter {
  // 活动传输
  private outgoing = new Map<number, OutgoingRow>(); // 发送方 transferId -> row
  /** 发送方 transferId -> 接收方本地行 */
  private incomingRows = new Map<number, IncomingRow>();

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
        this.onOffer(header as LanFileOffer, socket);
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

  /** 发送方：向对端发起单文件传输，返回发送方本地 transferId */
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
        // 记录一条 out 文件消息，让对话框里能看到「已发送文件」
        this.store.addMessage({
          peerId: peer.id,
          dir: 'out',
          kind: 'file',
          text: `文件：${name}（${stat.size} 字节）`,
          meta: JSON.stringify({ fileName: name, size: stat.size, transferId }),
          ts: Date.now(),
        });
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
    this.sendFileStream(msg.transferId, t, socket);
  }

  private sendFileStream(transferId: number, t: OutgoingRow, socket: net.Socket): void {
    const name = path.basename(t.path);
    // 文件传输期间该连接专用于文件：摘除 chat 的帧解析器（对称于接收方）
    this.chat.pauseFrames(socket);

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
      this.chat.resumeFrames(socket);
      this.store.updateTransfer(transferId, { state: 'done' });
      this.emitProgress(transferId, t.peer.id, 'out', name, t.size, sent, 'done');
      this.outgoing.delete(transferId);
    });
    rs.on('error', () => {
      this.chat.resumeFrames(socket);
      this.store.updateTransfer(transferId, { state: 'failed' });
      this.emitProgress(transferId, t.peer.id, 'out', name, t.size, sent, 'failed');
      this.outgoing.delete(transferId);
    });
  }

  private onDone(msg: LanFileDone): void {
    // 发送方收到接收方的 file-done 确认（v1 单文件，发送方在 rs.on('end') 已自行结束）
    void msg;
  }

  // ---------- 接收方 ----------

  private onOffer(msg: LanFileOffer, socket: net.Socket): void {
    // 关键：不依赖 discovery 查找发送方（组播有延迟，TCP 先到时可能查不到）。
    // peer 的 id/name 直接来自 file-offer 帧；后续拿 socket 用 handleFrame 传入的参数。
    const peer: PeerInfo = {
      id: msg.id,
      name: msg.name,
      ip: '',
      tcpPort: 0,
      lastSeen: Date.now(),
      online: true,
    };

    // 接收方本地 transfer 记录（本地自增 id，区别于发送方的 msg.transferId）
    const localTransferId = this.store.addTransfer({
      peerId: msg.id,
      dir: 'in',
      kind: msg.kind,
      name: msg.fileName,
      size: msg.size,
      state: 'pending',
      path: '',
      ts: Date.now(),
    });

    this.incomingRows.set(msg.transferId, {
      peer,
      savePath: '',
      fileName: msg.fileName,
      localTransferId,
      size: msg.size,
    });

    const offer: IncomingOffer = {
      transferId: msg.transferId, // 发送方 transferId，用于 acceptFile 关联
      peerId: msg.id,
      peerName: msg.name,
      fileName: msg.fileName,
      size: msg.size,
      kind: msg.kind,
    };

    if (this.store.isAutoAccept(msg.id)) {
      const savePath = path.join(this.defaultSaveDir(), msg.fileName);
      this.accept(msg.transferId, true, savePath, socket);
    } else {
      this.emit('incoming-offer', offer);
      // 记住这个 socket（accept 时可能已不是同一连接引用，但 v1 相同 peer 复用连接）
      this.incomingSockets.set(msg.transferId, socket);
    }
  }

  /** 发送方 transferId -> 收到 offer 时的 socket（供 accept 使用） */
  private incomingSockets = new Map<number, net.Socket>();

  /** 接收方：应答并开始接收 */
  accept(transferId: number, ok: boolean, savePath?: string, socket?: net.Socket): void {
    const row = this.incomingRows.get(transferId);
    if (!row) return;
    const sock = socket ?? this.chat.getConnections().get(row.peer.id) ?? this.incomingSockets.get(transferId);

    // savePath 兜底：未指定（UI 未点「更改目录」）时回退到默认下载目录 + 文件名
    const dest = savePath || path.join(this.defaultSaveDir(), row.fileName);

    const reply: LanFileAccept = {
      v: PROTO_VERSION,
      type: 'file-accept',
      id: this.chatId(),
      name: this.chatName(),
      transferId,
      ok,
      reason: ok ? undefined : '用户拒绝',
    };
    sock?.write(encodeFrame(reply));

    if (ok && sock) {
      this.beginReceive(transferId, row, dest, sock);
    } else if (!ok) {
      // 拒绝：标记本地记录失败并清理
      this.store.updateTransfer(row.localTransferId, { state: 'failed' });
      this.emitProgress(row.localTransferId, row.peer.id, 'in', row.fileName, row.size, 0, 'failed');
      this.incomingRows.delete(transferId);
      this.incomingSockets.delete(transferId);
    }
  }

  private beginReceive(
    senderTransferId: number,
    row: IncomingRow,
    savePath: string,
    socket: net.Socket,
  ): void {
    row.savePath = savePath;
    this.incomingSockets.delete(senderTransferId);
    const { peer, localTransferId, size } = row;
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
        this.store.updateTransfer(localTransferId, { size: received });
        this.emitProgress(localTransferId, peer.id, 'in', path.basename(savePath), size, received, 'receiving');
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
            this.store.updateTransfer(localTransferId, { state: 'done', path: savePath });
            this.emitProgress(localTransferId, peer.id, 'in', path.basename(savePath), size, received, 'done');
            // 记录一条 in 文件消息，让对话框里能看到「收到文件」
            this.store.addMessage({
              peerId: peer.id,
              dir: 'in',
              kind: 'file',
              text: `文件：${path.basename(savePath)}（${size} 字节）`,
              meta: JSON.stringify({ fileName: path.basename(savePath), size, savePath }),
              ts: Date.now(),
            });
          } catch {
            this.store.updateTransfer(localTransferId, { state: 'failed' });
            this.emitProgress(localTransferId, peer.id, 'in', path.basename(savePath), size, received, 'failed');
          }
        } else {
          try {
            fs.rmSync(partPath, { force: true });
          } catch {
            /* ignore */
          }
          this.store.updateTransfer(localTransferId, { state: 'failed' });
          this.emitProgress(localTransferId, peer.id, 'in', path.basename(savePath), size, received, 'failed');
        }
        this.incomingRows.delete(senderTransferId);
      });
    };

    socket.on('data', onData);
    socket.once('close', () => {
      if (received < size) finish(false);
    });
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
    this.incomingSockets.clear();
  }
}
