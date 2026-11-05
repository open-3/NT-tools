import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';

/**
 * 只读打开 sqlite。
 *
 * 硬约束（见设计方案 §7.2）：本程序对 agent 数据目录只有读权限，
 * 所有数据库一律 readOnly，不存在任何写入路径。
 *
 * 注意：不要用 immutable=1 —— 那会忽略 WAL，读不到最新的未落盘数据。
 */
export function openDb(filePath: string): DatabaseSync | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
}

export function closeDb(db: DatabaseSync | null): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

export function all<T = any>(db: DatabaseSync | null, sql: string, ...params: any[]): T[] {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

export function get<T = any>(db: DatabaseSync | null, sql: string, ...params: any[]): T | null {
  if (!db) return null;
  try {
    return (db.prepare(sql).get(...params) as T) ?? null;
  } catch {
    return null;
  }
}
