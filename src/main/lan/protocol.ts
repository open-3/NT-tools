/**
 * 局域网通信协议常量与消息帧编解码。
 *
 * 协议 v1（仅 Agent Pulse 互通，预留扩展位给 v2 兼容标准协议）：
 *
 *  发现（UDP 组播，纯 JSON，无需分帧）：
 *    { v:1, type:"hello", app:"agent-pulse", id:<UUID>, name:<主机名>, ip?:<string>, tcpPort:<number>, tsp:<ms> }
 *
 *  通道（TCP，分块流式，帧格式 = 4 字节大端长度 + JSON 头 + 负载字节）：
 *    握手      { v:1, type:"hello", id, name, tcpPort, tsp }
 *    聊天      { v:1, type:"chat", id, name, text, ts, kind:"text"|"broadcast" }
 *    广播      kind="broadcast"（text 承载；接收端正常入历史）
 *    文件请求  { v:1, type:"file-offer", id, name, transferId, name, size, kind:"file"|"dir", pin?:number, ts }
 *    文件应答  { v:1, type:"file-accept", id, name, transferId, ok:boolean, pin?:number, reason? }
 *    传输链    「4字节长度 + 纯二进制块」：首个 payload 块前无头，靠 transferId 关联
 *    结束      { v:1, type:"file-done", id, name, transferId, ok, reason? }
 *    心跳/离线 { v:1, type:"bye", id, name }
 */

export const APP_ID = 'agent-pulse';
export const PROTO_VERSION = 1;

/** UDP 组播组 + 端口 */
export const MULTICAST_ADDR = '239.255.42.99';
export const MULTICAST_PORT = 45317;

/** TCP 服务端口（0 = 随机绑定） */
export const TCP_PORT = 0;

/** 心跳间隔 / 离线判定 */
export const HELLO_INTERVAL_MS = 3000;
export const PEER_TIMEOUT_MS = 9000;

/** 文件分块大小（256KB，>2GB 文件内存恒定） */
export const CHUNK_SIZE = 256 * 1024;

/** 消息头最大长度（防御畸形帧） */
export const MAX_HEADER_BYTES = 64 * 1024;

export interface LanHello {
  v: number;
  type: 'hello' | 'bye';
  app: string;
  id: string; // 对端 UUID
  name: string; // 主机名
  ip?: string;
  tcpPort: number;
  tsp: number;
}

export interface LanChatMsg {
  v: number;
  type: 'chat';
  id: string;
  name: string;
  text: string;
  ts: number;
  kind: 'text' | 'broadcast';
}

export interface LanFileOffer {
  v: number;
  type: 'file-offer';
  id: string;
  name: string;
  transferId: number;
  fileName: string;
  size: number;
  kind: 'file' | 'dir';
  ts: number;
}

export interface LanFileAccept {
  v: number;
  type: 'file-accept';
  id: string;
  name: string;
  transferId: number;
  ok: boolean;
  reason?: string;
}

export interface LanFileDone {
  v: number;
  type: 'file-done';
  id: string;
  name: string;
  transferId: number;
  ok: boolean;
  reason?: string;
}

export type LanHeader =
  | LanHello
  | LanChatMsg
  | LanFileOffer
  | LanFileAccept
  | LanFileDone;

/** 编码一帧（4 字节长度 + JSON 头）。纯 JSON 帧，无负载。 */
export function encodeFrame(msg: LanHeader): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** 解析帧头 JSON；返回 null 表示缓冲不足，需等更多数据。 */
export function tryParseHeader(buf: Buffer): { header: LanHeader; consumed: number } | null {
  if (buf.length < 4) return null;
  const len = buf.readUInt32BE(0);
  if (len > MAX_HEADER_BYTES) throw new Error(`帧头过大：${len}`);
  if (buf.length < 4 + len) return null;
  const body = buf.subarray(4, 4 + len).toString('utf8');
  const header = JSON.parse(body) as LanHeader;
  return { header, consumed: 4 + len };
}

/** 编码一块文件负载（4 字节长度 + 二进制）。transferId 已在握手头里，负载纯字节。 */
export function encodeChunk(buf: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export function jsonFrame(msg: LanHeader): Buffer {
  return encodeFrame(msg);
}
