import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { userDataPath } from './env';

/**
 * 局域网通信的本地 SQLite 存储（Node 22 内置 node:sqlite，零依赖）。
 *
 * 存 `%APPDATA%\agent-pulse\lan.db`。三张表：
 *  - peers:     已知对端（用于记住「来自该设备的文件直接接收」选择）
 *  - messages:  聊天历史（一对一 / 广播）
 *  - transfers: 传输历史（文件收发记录）
 *
 * 所有字段按需精简；发送方信息用 peerId（UUID，可跨 IP 变化保持稳定）。
 */

export interface PeerRow {
  id: string; // UUID
  hostname: string;
  /** displayName 由渲染层拼 IP、这里只存元数据 */
  autoAccept: number; // 0/1：来自该设备的文件是否直接接收
  lastSeen: number;
}

export interface MessageRow {
  id: number;
  peerId: string; // 对方 peerId；广播时为空字符串
  dir: 'in' | 'out';
  kind: 'text' | 'broadcast' | 'file';
  text: string;
  meta: string; // JSON：文件名/大小等
  ts: number;
}

export interface TransferRow {
  id: number;
  peerId: string;
  dir: 'in' | 'out';
  kind: 'file' | 'dir';
  name: string;
  size: number;
  state: 'pending' | 'sending' | 'receiving' | 'done' | 'failed';
  path: string; // 落盘路径（接收）或源路径（发送）
  ts: number;
}

export class LanStore {
  private db: DatabaseSync;

  constructor() {
    const file =
      process.env.AGENT_PULSE_LAN_DB || path.join(userDataPath(), 'lan.db');
    this.db = new DatabaseSync(file);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL DEFAULT '',
        autoAccept INTEGER NOT NULL DEFAULT 0,
        lastSeen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peerId TEXT NOT NULL,
        dir TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        text TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages(peerId, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peerId TEXT NOT NULL,
        dir TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'file',
        name TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        path TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transfers_ts ON transfers(ts);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  /** 读取设置项 */
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** 写入设置项 */
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** 已知对端信息；不存在返回 undefined */
  getPeer(id: string): PeerRow | undefined {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as
      | PeerRow
      | undefined;
    return row;
  }

  /** 记录 / 更新对端（upsert） */
  upsertPeer(id: string, hostname: string): void {
    this.db
      .prepare(
        `INSERT INTO peers (id, hostname, lastSeen) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, lastSeen = excluded.lastSeen`,
      )
      .run(id, hostname, Date.now());
  }

  setAutoAccept(id: string, on: boolean): void {
    this.db.prepare('UPDATE peers SET autoAccept = ? WHERE id = ?').run(on ? 1 : 0, id);
    // 若对端尚未入库（比如首次就决定记住），先补一条空记录
    const c = this.db.prepare('SELECT changes() AS c').get() as { c?: number } | undefined;
    if ((c?.c ?? 0) === 0) {
      this.db
        .prepare('INSERT INTO peers (id, hostname, autoAccept) VALUES (?, ?, ?)')
        .run(id, '', on ? 1 : 0);
    }
  }

  isAutoAccept(id: string): boolean {
    return this.getPeer(id)?.autoAccept === 1;
  }

  addMessage(m: Omit<MessageRow, 'id'>): number {
    const r = this.db
      .prepare('INSERT INTO messages (peerId, dir, kind, text, meta, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.peerId, m.dir, m.kind, m.text, m.meta, m.ts);
    return Number(r.lastInsertRowid);
  }

  /** 与某对端的最近 N 条消息（时间升序） */
  getMessages(peerId: string, limit = 200): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE peerId = ? ORDER BY ts DESC LIMIT ?')
      .all(peerId, limit) as unknown as MessageRow[];
  }

  addTransfer(t: Omit<TransferRow, 'id'>): number {
    const r = this.db
      .prepare(
        'INSERT INTO transfers (peerId, dir, kind, name, size, state, path, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.peerId, t.dir, t.kind, t.name, t.size, t.state, t.path, t.ts);
    return Number(r.lastInsertRowid);
  }

  updateTransfer(id: number, patch: Partial<Pick<TransferRow, 'state' | 'size' | 'path'>>): void {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of ['state', 'size', 'path'] as const) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(patch[k]);
      }
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getRecentTransfers(limit = 50): TransferRow[] {
    return this.db.prepare('SELECT * FROM transfers ORDER BY ts DESC LIMIT ?').all(limit) as unknown as TransferRow[];
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
