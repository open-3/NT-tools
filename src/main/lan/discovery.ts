import * as dgram from 'node:dgram';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { userDataPath } from './env';
import { APP_ID, MULTICAST_ADDR, MULTICAST_PORT, HELLO_INTERVAL_MS, PEER_TIMEOUT_MS, LanHello } from './protocol';
import { LanStore } from './store';

/**
 * UDP 组播发现：每 3s 广播 hello，9s 无响应判离线。
 *
 * 借鉴飞鸽/LocalSend：自动发现 + 在线列表，免配置。
 * 身份（UUID + 主机名）由 Discovery.identity() 统一生成/读取，
 * 被 ChatService / TransferService 共享，保证协议里 id 一致。
 */

export interface PeerInfo {
  id: string;
  name: string; // 主机名
  ip: string; // 来源 IP（last known）
  tcpPort: number;
  lastSeen: number;
  online: boolean;
}

export class Discovery {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private peers = new Map<string, PeerInfo>();
  private listeners = new Set<(peers: PeerInfo[]) => void>();
  private ownIps = new Set<string>();

  constructor(
    private store: LanStore,
    private tcpPort: number,
    private selfId: string,
    private selfName: string,
  ) {
    this.ownIps = this.localIps();
  }

  /** 读取/生成本机身份（跨重启稳定的 UUID + 主机名） */
  static identity(): { id: string; name: string } {
    // 测试或自定义场景可用 env 覆盖 userData 路径；否则取 app.getPath('userData')
    const base = userDataPath();
    const file = path.join(base, 'lan-id.txt');
    let id = '';
    try {
      id = fs.readFileSync(file, 'utf8').trim();
    } catch {
      /* first run */
    }
    if (!id) {
      id = randomUUID();
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(file, id, 'utf8');
      } catch {
        /* ignore */
      }
    }
    return { id, name: os.hostname() };
  }

  get id(): string {
    return this.selfId;
  }

  get name(): string {
    return this.selfName;
  }

  private localIps(): Set<string> {
    const ips = new Set<string>();
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) ips.add(iface.address);
      }
    }
    return ips;
  }

  start(): void {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;

    sock.on('error', (err) => {
      console.error('[lan] discovery error', err?.message);
    });

    sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));

    sock.bind(MULTICAST_PORT, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(32);
        // 生产环境禁用本机回环（避免把自己识别为对端）。
        // 同机多实例测试（如 e2e）需开启回环才能互见，用 env 覆盖。
        sock.setMulticastLoopback(process.env.AGENT_PULSE_LAN_LOOPBACK === '1');
        sock.addMembership(MULTICAST_ADDR);
      } catch (e: any) {
        console.error('[lan] multicast join failed', e?.message);
      }
      this.sendHello();
      this.timer = setInterval(() => this.sendHello(), HELLO_INTERVAL_MS);
      this.sweep = setInterval(() => this.sweepPeers(), 1000);
    });
  }

  private sendHello(): void {
    if (!this.socket) return;
    const hello: LanHello = {
      v: 1,
      type: 'hello',
      app: APP_ID,
      id: this.selfId,
      name: this.selfName,
      tcpPort: this.tcpPort,
      tsp: Date.now(),
    };
    // UDP 发现用纯 JSON（无长度前缀），与协议注释一致
    this.socket.send(JSON.stringify(hello), MULTICAST_PORT, MULTICAST_ADDR);
  }

  private onMessage(raw: Buffer, srcIp: string): void {
    let data: LanHello;
    try {
      data = JSON.parse(raw.toString('utf8')) as LanHello;
    } catch {
      return;
    }
    if (!data || data.app !== APP_ID || data.type !== 'hello') return;
    if (data.id === this.selfId) return; // 自己（环回 / 其它网卡）

    const prev = this.peers.get(data.id);
    const online = prev?.online ?? false;
    const info: PeerInfo = {
      id: data.id,
      name: data.name || '未知设备',
      ip: srcIp,
      tcpPort: data.tcpPort,
      lastSeen: Date.now(),
      online: true,
    };
    this.peers.set(data.id, info);
    this.store.upsertPeer(data.id, data.name || srcIp);

    if (!online || prev?.ip !== srcIp || prev?.tcpPort !== data.tcpPort) {
      this.emit();
    }
  }

  private sweepPeers(): void {
    const now = Date.now();
    let changed = false;
    for (const p of this.peers.values()) {
      if (p.online && now - p.lastSeen > PEER_TIMEOUT_MS) {
        p.online = false;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  get(id: string): PeerInfo | undefined {
    return this.peers.get(id);
  }

  onChange(fn: (peers: PeerInfo[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const list = this.list();
    for (const fn of this.listeners) {
      try {
        fn(list);
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweep) clearInterval(this.sweep);
    this.timer = null;
    this.sweep = null;
    if (this.socket) {
      try {
        // 广播 bye 再关
        const bye: LanHello = {
          v: 1,
          type: 'bye',
          app: APP_ID,
          id: this.selfId,
          name: this.selfName,
          tcpPort: this.tcpPort,
          tsp: Date.now(),
        };
        this.socket.send(JSON.stringify(bye), MULTICAST_PORT, MULTICAST_ADDR);
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.peers.clear();
  }
}

/** 选择本机一个可用的局域网 IPv4 */
export function primaryIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
