import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, AgentSession, SessionState } from './types';
import { openDb, closeDb, all, get } from '../sources/sqlite';
import { buildContext } from '../project';

/**
 * WorkBuddy 适配器（国内版 workbuddy.cn + 国际版 workbuddy.ai 双版本）
 *
 * 数据源（全部只读）：
 *   ~/.workbuddy/workbuddy.db      → sessions 表（国内版）
 *   ~/.workbuddy-ai/workbuddy.db   → sessions 表（国际版）
 *
 * 关键字段（从 app.asar 反查确认）：
 *   status        会话状态，取值 pending / working / completed / cancelled / failed
 *                 —— 由 conversation 状态机写入，来源见下
 *   unread        未读标记（migration 0013 加入）
 *   last_activity_at  最后活动时间
 *   title / custom_title  标题（custom_title 为用户重命名，优先）
 *   cwd           工作目录
 *   deleted_at    软删除标记
 *   permission_mode  权限模式（bypassPermissions 等）
 *
 * 状态机（app.asar 中的 conversation 状态机，已反查确认）：
 *   idle → planning → working → finalizing → pending → idle
 *   其中 pending 的转移条件是「用户应答权限/问答」，即**等待用户**。
 *   对应事件：PERMISSION_REQUESTED → PERMISSION_RESOLVED。
 *
 * 因此 status='pending' 就是「待我确认」，这是**精确信号**，不是推断。
 */

const HOME = os.homedir();

/** 两个发行版的数据根目录。国内版是 .workbuddy，国际版是 .workbuddy-ai */
const EDITIONS = [
  { key: 'wb-cn', label: 'WorkBuddy', badge: 'W', dir: path.join(HOME, '.workbuddy') },
  { key: 'wb-ai', label: 'WorkBuddy AI', badge: 'W', dir: path.join(HOME, '.workbuddy-ai') },
] as const;

const STALE_MS = 6 * 60 * 60_000;
const DONE_WINDOW_MS = 2 * 60 * 60_000;

interface SessionRow {
  id: string;
  cwd: string | null;
  title: string | null;
  custom_title: string | null;
  status: string | null;
  unread: number | null;
  last_activity_at: number | null;
  updated_at: number | null;
  created_at: number | null;
  deleted_at: number | null;
  permission_mode: string | null;
  mode: string | null;
  model: string | null;
  is_background_automation: number | null;
  transport: string | null;
}

/**
 * WorkBuddy 的 status 是大小写混用的（表默认值写的是 'Pending'，
 * 实际运行时写入的是小写 'pending'），统一转小写比较。
 */
function normalizeStatus(raw: string | null): string {
  return (raw ?? '').trim().toLowerCase();
}

function projectOf(cwd: string | null): string {
  if (!cwd) return '';
  const clean = cwd.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const seg = clean.split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

function pickTitle(s: SessionRow): string {
  const custom = (s.custom_title ?? '').trim();
  if (custom) return custom;
  const title = (s.title ?? '').trim();
  if (title) return title.length > 120 ? title.slice(0, 120) + '…' : title;
  return projectOf(s.cwd) || '未命名对话';
}

/** 把 WorkBuddy 的会话状态映射到统一状态 */
function mapState(status: string, unread: boolean): SessionState | null {
  switch (status) {
    case 'pending':
      // 状态机里的 pending = 等用户应答权限/问答，精确的「待确认」
      return 'waiting_user';
    case 'working':
    case 'planning':
    case 'finalizing':
    case 'running':
    case 'in_progress':
      return 'running';
    case 'completed':
    case 'done':
      return unread ? 'done_unread' : null;
    case 'cancelled':
    case 'failed':
    case 'error':
      return unread ? 'done_unread' : null;
    case 'idle':
      return unread ? 'done_unread' : null;
    default:
      return null;
  }
}

function describeStatus(status: string): string {
  switch (status) {
    case 'pending':
      return '等待授权';
    case 'working':
      return '处理中';
    case 'planning':
      return '规划中';
    case 'finalizing':
      return '收尾中';
    default:
      return '处理中';
  }
}

class WorkBuddyEdition {
  constructor(
    readonly key: string,
    readonly label: string,
    readonly badge: string,
    readonly dir: string,
  ) {}

  private get dbPath(): string {
    return path.join(this.dir, 'workbuddy.db');
  }

  detect(): boolean {
    return fs.existsSync(this.dir) && fs.existsSync(this.dbPath);
  }

  snapshot(now: number): AgentSession[] {
    if (!this.detect()) return [];
    const db = openDb(this.dbPath);
    try {
      const rows = all<SessionRow>(
        db,
        `SELECT id, cwd, title, custom_title, status, unread,
                last_activity_at, updated_at, created_at, deleted_at,
                permission_mode, mode, model, is_background_automation, transport
           FROM sessions
          WHERE deleted_at IS NULL
            AND COALESCE(is_background_automation, 0) = 0
          ORDER BY COALESCE(last_activity_at, updated_at) DESC
          LIMIT 200`,
      );

      const out: AgentSession[] = [];
      for (const r of rows) {
        const status = normalizeStatus(r.status);
        const unread = !!r.unread;
        const state = mapState(status, unread);
        if (!state) continue;

        const lastActivity = r.last_activity_at ?? r.updated_at ?? r.created_at ?? 0;
        if (now - lastActivity > STALE_MS) continue;

        let stateSince = lastActivity;
        if (state === 'done_unread') {
          stateSince = r.updated_at ?? lastActivity;
          if (now - stateSince > DONE_WINDOW_MS) continue;
        }

        const isWaiting = state === 'waiting_user';
        out.push({
          key: `${this.key}:${r.id}`,
          agent: this.key,
          agentLabel: this.label,
          badge: this.badge,
          title: pickTitle(r),
          project: projectOf(r.cwd),
          context: buildContext(r.cwd),
          state,
          stateSince,
          lastActivityAt: lastActivity,
          // status='pending' 来自状态机明确的 PERMISSION_REQUESTED，属精确信号
          confidence: 'exact',
          activity: {
            kind: isWaiting ? 'waiting' : 'tool',
            label: isWaiting ? '等待授权' : describeStatus(status),
          },
          pending: isWaiting
            ? { kind: 'approval', reason: '等待授权或回答', since: stateSince }
            : undefined,
          unread: state === 'done_unread',
        });
      }
      return out;
    } finally {
      closeDb(db);
    }
  }
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy';
  readonly label = 'WorkBuddy';
  readonly badge = 'W';

  private editions = EDITIONS.map((e) => new WorkBuddyEdition(e.key, e.label, e.badge, e.dir));

  detect(): boolean {
    return this.editions.some((e) => e.detect());
  }

  snapshot(): AgentSession[] {
    const now = Date.now();
    const out: AgentSession[] = [];
    for (const ed of this.editions) {
      try {
        out.push(...ed.snapshot(now));
      } catch {
        // 单个版本读失败不影响另一个
      }
    }
    return out;
  }
}

/** 供测试使用：暴露状态映射规则 */
export const __test__ = { mapState, normalizeStatus, pickTitle, projectOf };
