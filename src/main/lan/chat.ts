import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  PROTO_VERSION,
  APP_ID,
  LanHeader,
  LanChatMsg,
  encodeFrame,
  tryParseHeader,
} from './protocol';
import { LanStore } from './store';
import { PeerInfo } from './discovery';

/**
 * 聊天连接：TCP 分块流式（net 模块）。
 *
 * 服务端（本机监听）接受任意 Agent Pulse 对端；客户端在需要发消息时主动连
 * 对端 tcpPort，握手后复用连接。帧格式见 protocol.ts：4 字节长度 + JSON 头。
 *
 * 帧分发：JSON 头解析出来后，chat 类型本模块处理；文件类型帧（file-*）通过
 * 'frame' 事件透传给 TransferService。负载字节块（文件内容）不含 JSON 头，
 * 由 TransferService 在拿到 socket 后自行监听 data 处理（见 transfer.ts）。
 */

interface ChatEvents {
  message: [msg: LanChatMsg, fromIp: string];
  peerConnected: [peerId: string];
  peerDisconnected: [peerId: string];
  listening: [port: number];
  frame: [header: LanHeader, socket: net.Socket];
}

export class ChatService extends EventEmitter {
  private server: net.Server | null = null;
  private tcpPort = 0;
  private conns = new Map<string, net.Socket>(); // peerId -> socket
  private buffers = new Map<net.Socket, Buffer>(); // 按 socket 累积（健壮且支持复用）
  private handlers = new Map<net.Socket, (chunk: Buffer) => void>(); // 每 socket 的 data 解析器（供文件传输期间摘除）

  constructor(
    private store: LanStore,
    private selfId: string,
    private selfName: string,
  ) {
    super();
  }

  get port(): number {
    return this.tcpPort;
  }

  /** socket 连接表（TransferService 复用） */
  getConnections(): ReadonlyMap<string, net.Socket> {
    return this.conns;
  }

  start(): void {
    if (this.server) return;
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (err) => {
      console.error('[lan] tcp server error', err?.message);
      this.emit('error', err);
    });
    this.server.listen(0, () => {
      const addr = this.server!.address();
      if (addr && typeof addr === 'object') {
        this.tcpPort = addr.port;
        this.emit('listening', this.tcpPort);
      }
    });
  }

  private onConnection(socket: net.Socket): void {
    this.buffers.set(socket, Buffer.alloc(0));
    const handler = (chunk: Buffer) => this.onData(socket, chunk);
    this.handlers.set(socket, handler);
    socket.on('data', handler);
    socket.on('error', () => this.onSocketClose(socket));
    socket.on('close', () => this.onSocketClose(socket));
  }

  /**
   * 文件传输期间摘除该 socket 的帧解析器，让原始字节只流向 TransferService。
   * 传完 resumeFrames 恢复。若该 socket 从未挂过解析器（如出站 socket 未走
   * onConnection），忽略即可。
   */
  pauseFrames(socket: net.Socket): void {
    const h = this.handlers.get(socket);
    if (h) socket.off('data', h);
  }

  resumeFrames(socket: net.Socket): void {
    const h = this.handlers.get(socket);
    if (h) socket.on('data', h);
  }

  private onData(socket: net.Socket, chunk: Buffer): void {
    let buf = Buffer.concat([this.buffers.get(socket) ?? Buffer.alloc(0), chunk]);
    while (buf.length > 0) {
      let parsed: { header: LanHeader; consumed: number } | null;
      try {
        parsed = tryParseHeader(buf);
      } catch {
        socket.destroy();
        this.buffers.delete(socket);
        return;
      }
      if (!parsed) break;
      buf = buf.subarray(parsed.consumed);
      this.dispatch(socket, parsed.header);
    }
    // 关键：无论是否解析出完整帧，剩下的部分帧（跨 TCP 包的长消息）都必须
    // 存回缓冲，否则下一次 data 会从空缓冲重读，导致长消息被静默丢弃。
    this.buffers.set(socket, buf);
  }

  private dispatch(socket: net.Socket, header: LanHeader): void {
    switch (header.type) {
      case 'hello':
        this.bindPeer(header.id, socket);
        break;
      case 'chat':
        this.handleChat(header as LanChatMsg, socket.remoteAddress ?? '');
        break;
      case 'bye':
        this.unbindPeer(header.id);
        break;
      default:
        // 文件帧透传
        this.emit('frame', header, socket);
        break;
    }
  }

  private bindPeer(peerId: string, socket: net.Socket): void {
    const old = this.conns.get(peerId);
    if (old && old !== socket) old.destroy();
    this.conns.set(peerId, socket);
    this.emit('peerConnected', peerId);
  }

  private unbindPeer(peerId: string): void {
    if (this.conns.delete(peerId)) {
      this.emit('peerDisconnected', peerId);
    }
  }

  private onSocketClose(socket: net.Socket): void {
    this.buffers.delete(socket);
    this.handlers.delete(socket);
    for (const [id, s] of this.conns) {
      if (s === socket) this.conns.delete(id);
    }
  }

  private handleChat(msg: LanChatMsg, fromIp: string): void {
    if (msg.v !== PROTO_VERSION) return;
    const kind = msg.kind === 'broadcast' ? 'broadcast' : 'text';
    this.store.addMessage({
      peerId: msg.id,
      dir: 'in',
      kind,
      text: msg.text,
      meta: '',
      ts: msg.ts || Date.now(),
    });
    this.emit('message', msg, fromIp.replace(/^::ffff:/, ''));
  }

  /** 主动发一条文字消息（异步）。 */
  sendChat(peer: PeerInfo, text: string, kind: 'text' | 'broadcast' = 'text'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.getOrConnect(peer, (err, sock) => {
        if (err || !sock) return reject(err ?? new Error('连接失败'));
        const msg: LanChatMsg = {
          v: PROTO_VERSION,
          type: 'chat',
          id: this.selfId,
          name: this.selfName,
          text,
          ts: Date.now(),
          kind,
        };
        sock.write(encodeFrame(msg), () => {
          this.store.addMessage({
            peerId: peer.id,
            dir: 'out',
            kind: kind === 'broadcast' ? 'broadcast' : 'text',
            text,
            meta: '',
            ts: Date.now(),
          });
          resolve();
        });
      });
    });
  }

  /** 获取或建立到对端的连接（连上即发握手，随后回调）。 */
  getOrConnect(peer: PeerInfo, cb: (err: Error | null, socket?: net.Socket) => void): net.Socket | null {
    const existing = this.conns.get(peer.id);
    if (existing && !existing.destroyed) {
      cb(null, existing);
      return existing;
    }
    const socket = net.connect(peer.tcpPort, peer.ip);
    let settled = false;

    socket.once('connect', () => {
      const hello = {
        v: PROTO_VERSION,
        type: 'hello' as const,
        app: APP_ID,
        id: this.selfId,
        name: this.selfName,
        tcpPort: this.tcpPort,
        tsp: Date.now(),
      };
      this.buffers.set(socket, Buffer.alloc(0));
      socket.write(encodeFrame(hello), () => {
        this.conns.set(peer.id, socket);
        settled = true;
        cb(null, socket);
        this.emit('peerConnected', peer.id);
      });
    });
    // 客户端的出站 socket 同样要监听 data/close，才能读对端回复（双向聊天）
    const handler = (chunk: Buffer) => this.onData(socket, chunk);
    this.handlers.set(socket, handler);
    socket.on('data', handler);
    socket.once('error', (err) => {
      if (!settled) {
        settled = true;
        cb(err);
      } else {
        this.onSocketClose(socket);
      }
    });
    socket.on('close', () => this.onSocketClose(socket));
    return socket;
  }

  /** 给所有在线对端广播文字消息 */
  broadcast(text: string, peers: PeerInfo[]): Promise<string[]> {
    const ok: string[] = [];
    const targets = peers.filter((p) => p.online);
    return Promise.all(
      targets.map((p) =>
        new Promise<void>((resolve) => {
          this.sendChat(p, text, 'broadcast')
            .then(() => {
              ok.push(p.id);
              resolve();
            })
            .catch(() => resolve());
        }),
      ),
    ).then(() => ok);
  }

  stop(): void {
    for (const s of this.conns.values()) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.buffers.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
    }
  }
}
