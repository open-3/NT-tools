import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { LanStore } from './store';
import { Discovery, PeerInfo, primaryIp } from './discovery';
import { ChatService } from './chat';
import { TransferService } from './transfer';

/**
 * 局域网通信门面：把 discovery / chat / transfer / store 组装起来，
 * 提供 renderer 可调用的统一 API（经 preload 的 window.lan 暴露）。
 *
 * 懒启动：首次打开 lanchat 工具时才开始 UDP 发现 + TCP 监听；
 * 关闭最后一个工具窗口时停止，减少常驻开销。
 *
 * 依赖顺序：先取得本机身份（id/name）→ chat listen(0) 拿到端口 → 用端口
 * 构建 discovery（hello 带真实 tcpPort）→ transfer 复用 chat 连接。
 * 身份（lan-id.txt 里的 UUID）由 Discovery 持有并以静态方式暴露，
 * 这样 ChatService / TransferService 都能拿到同一身份。
 */

export interface LanSnapshot {
  self: { id: string; name: string; ip: string; tcpPort: number };
  peers: PeerInfo[];
}

export class LanManager extends EventEmitter {
  private store: LanStore;
  private discovery: Discovery | null = null;
  private chat: ChatService | null = null;
  private transfer: TransferService | null = null;
  private running = false;
  private refs = 0;

  constructor() {
    super();
    this.store = new LanStore();
  }

  /** 懒启动；幂等。 */
  start(): void {
    this.refs++;
    if (this.running) return;

    // 1) 身份
    const { id, name } = Discovery.identity();

    // 2) 先启 TCP 拿端口
    const chat = new ChatService(this.store, id, name);
    this.chat = chat;
    chat.start();

    // 3) 端口确定后建 discovery（hello 带真实 tcpPort），再建 transfer + wire
    chat.once('listening', (port: number) => {
      if (this.running) return;
      const discovery = new Discovery(this.store, port, id, name);
      this.discovery = discovery;
      this.transfer = new TransferService(this.store, chat, discovery);
      this.wire();
      chat.on('frame', (header, socket) => this.transfer!.handleFrame(header, socket));
      discovery.start();
      this.running = true;
      // 发送正式 hello（身份 id/name 已在构造传入）
      this.emit('snapshot', this.snapshot());
    });

    // 兜底：listen 出错也建 discovery（端口 0）
    chat.once('error', () => {
      if (this.running || this.discovery) return;
      const discovery = new Discovery(this.store, 0, id, name);
      this.discovery = discovery;
      this.transfer = new TransferService(this.store, chat, discovery);
      this.wire();
      chat.on('frame', (header, socket) => this.transfer!.handleFrame(header, socket));
      discovery.start();
      this.running = true;
    });
  }

  private wire(): void {
    this.discovery?.onChange(() => this.emit('snapshot', this.snapshot()));
    this.chat?.on('message', () => this.emit('message'));
    this.transfer?.on('progress', (p) => this.emit('transfer-progress', p));
    this.transfer?.on('incoming-offer', (o) => this.emit('incoming-offer', o));
  }

  /** 释放一个引用；归零则停止 */
  stop(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0 && this.running) {
      this.discovery?.stop();
      this.chat?.stop();
      this.transfer?.stop();
      this.running = false;
      this.discovery = null;
      this.chat = null;
      this.transfer = null;
    }
  }

  snapshot(): LanSnapshot {
    return {
      self: {
        id: this.discovery?.id ?? '',
        name: this.discovery?.name ?? '',
        ip: primaryIp(),
        tcpPort: this.chat?.port ?? 0,
      },
      peers: this.discovery?.list() ?? [],
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ---- renderer 可调用的 API（经 IPC 桥接）----

  getSnapshot(): LanSnapshot {
    return this.snapshot();
  }

  async sendChat(peerId: string, text: string): Promise<void> {
    const peer = this.discovery?.get(peerId);
    if (!peer) throw new Error('对方不在线');
    if (!this.chat) throw new Error('通道未启动');
    await this.chat.sendChat(peer, text, 'text');
  }

  async broadcast(text: string): Promise<string[]> {
    if (!this.chat || !this.discovery) return [];
    return this.chat.broadcast(text, this.discovery.list());
  }

  async sendFile(peerId: string, filePath: string): Promise<number> {
    const peer = this.discovery?.get(peerId);
    if (!peer) throw new Error('对方不在线');
    if (!this.transfer) throw new Error('传输未启动');
    return this.transfer.offer(peer, filePath);
  }

  acceptFile(transferId: number, ok: boolean, savePath?: string): void {
    this.transfer?.accept(transferId, ok, savePath);
  }

  getMessages(peerId: string, limit = 200) {
    return this.store.getMessages(peerId, limit);
  }
}

/** 单例，由 main.ts 持有并桥接到 renderer */
export const lanManager = new LanManager();
