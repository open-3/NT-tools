import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, AgentSession, SessionState } from './types';
import { openDb, closeDb, all, get } from '../sources/sqlite';
import { summarize } from '../summary';
import { buildContext, projectName } from '../project';

/**
 * Devin 适配器（Cognition 的云端 AI 工程师）。
 *
 * 数据源（只读）：
 *   %APPDATA%\Devin\cli\sessions.db  → sessions / live_row_times / message_nodes
 *
 * 状态判定的关键限制（实测）：
 *   Devin 的 sessions 表**没有显式的 running/done/pending 字段**，
 *   只有 created_at / last_activity_at 两个时间戳 + live_row_times 的实时流式行。
 *
 *   所以只能两档推断：
 *     - 进行中    ：last_activity_at 很近（心跳活跃）
 *     - 完成未读  ：活动已停、且未被 ack
 *
 *   「待确认」这一档**不做**（方案 A）——Devin 没有 pending/waiting 信号，
 *   连 Codex 那种 inProgress 字段都没有，纯瞎猜违背「不假装」原则。
 *   将来 Devin 暴露更好信号再加。
 */

const HOME = os.homedir();
const DEVIN_DB =
  process.env.AGENT_PULSE_DEVIN_DB ||
  path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Devin', 'cli', 'sessions.db');

/** 进行中的心跳阈值：last_activity_at 距现在小于这个，算「在跑」 */
const RUNNING_MS = 5 * 60 * 1000;
/** 超过这个时长没有活动，直接不显示（太久远的会话无意义） */
const STALE_MS = 24 * 60 * 60 * 1000;
/** 完成未读只保留最近这么久内的（对齐其他 adapter 的策略） */
const DONE_WINDOW_MS = 2 * 60 * 60 * 1000;

interface DevinSessionRow {
  id: string;
  title: string | null;
  working_directory: string | null;
  agent_mode: string | null;
  model: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  hidden: number | null;
}

interface LiveRow {
  session_id: string;
  row_key: string;
  started_at: string | null;
}

interface MessageRow {
  session_id: string;
  chat_message: string | null;
  node_id: string;
}

/** 清洗标题：Devin 的 title 一般已干净，但可能带 markdown/长文，压到单行 */
function cleanDevinTitle(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  let t = raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  // 剥掉 markdown 井号前缀
  t = t.replace(/^[#>\-*]+\s*/, '');
  if (!t) return fallback;
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

/** 把 live_row_times 的 row_key 翻译成「现在在干嘛」 */
function describeLiveRow(rowKey: string | null | undefined): { kind: 'tool' | 'thinking'; label: string } | undefined {
  if (!rowKey) return undefined;
  if (rowKey.startsWith('tool:')) {
    return { kind: 'tool', label: '执行工具' };
  }
  if (rowKey.startsWith('thought:')) {
    return { kind: 'thinking', label: '思考中' };
  }
  if (rowKey.startsWith('text:')) {
    return { kind: 'thinking', label: '输出回复' };
  }
  return { kind: 'thinking', label: '工作中' };
}

/** 从 message_nodes 最新一条 assistant 消息提取结果摘要 */
function latestResultSummary(rows: MessageRow[]): string | undefined {
  // rows 已按 row_id DESC 排序，找第一条 role=assistant 且有 content 的
  for (const r of rows) {
    if (!r.chat_message) continue;
    try {
      const m = JSON.parse(r.chat_message);
      if (m?.role !== 'assistant') continue;
      const text = extractMessageText(m);
      if (text) return summarize(text) || undefined;
    } catch {
      /* 跳过坏数据 */
    }
  }
  return undefined;
}

/** 提取 chat_message JSON 里的纯文本（content 数组只取 text 块，排除 thinking） */
function extractMessageText(m: any): string {
  const content = m?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text);
    return texts.join(' ').trim();
  }
  if (typeof content === 'string') return content.trim();
  return '';
}

export class DevinAdapter implements AgentAdapter {
  readonly id = 'devin';
  readonly label = 'Devin';
  readonly badge = 'D';

  detect(): boolean {
    return fs.existsSync(DEVIN_DB);
  }

  snapshot(): AgentSession[] {
    if (!this.detect()) return [];
    const now = Date.now();
    const db = openDb(DEVIN_DB);
    try {
      // 未隐藏的会话，按最后活动倒序
      const sessions = all<DevinSessionRow>(
        db,
        `SELECT id, title, working_directory, agent_mode, model, created_at, last_activity_at, hidden
           FROM sessions
          WHERE COALESCE(hidden, 0) = 0
          ORDER BY last_activity_at DESC
          LIMIT 120`,
      );
      if (sessions.length === 0) return [];

      const ids = sessions.map((s) => s.id);
      const placeholders = ids.map(() => '?').join(',');

      // 每个会话最新的 live_row_times（实时心跳信号，按 started_at 取最新）
      const liveRows = all<LiveRow>(
        db,
        `SELECT l.session_id, l.row_key, l.started_at
           FROM live_row_times l
           JOIN (SELECT session_id, MAX(started_at) AS mx
                   FROM live_row_times
                  WHERE session_id IN (${placeholders})
                  GROUP BY session_id) m
             ON l.session_id = m.session_id AND l.started_at = m.mx
          GROUP BY l.session_id`,
        ...ids,
      );
      const liveBySession = new Map(liveRows.map((r) => [r.session_id, r]));

      // 每个会话最新的 message_nodes（用于结果摘要），按 row_id 取最近的若干条
      const messageRows = all<MessageRow>(
        db,
        `SELECT session_id, chat_message, node_id
           FROM message_nodes
          WHERE session_id IN (${placeholders})
          ORDER BY row_id DESC
          LIMIT 2000`,
        ...ids,
      );
      const messagesBySession = new Map<string, MessageRow[]>();
      for (const m of messageRows) {
        const arr = messagesBySession.get(m.session_id) ?? [];
        arr.push(m);
        messagesBySession.set(m.session_id, arr);
      }

      const out: AgentSession[] = [];
      for (const s of sessions) {
        // Devin 时间戳是秒级 Unix（10 位），转 ms
        const lastActivityMs = (s.last_activity_at ?? 0) * 1000;
        if (lastActivityMs <= 0) continue;
        if (now - lastActivityMs > STALE_MS) continue;

        const live = liveBySession.get(s.id);

        let state: SessionState;
        let stateSince: number;
        let activity: AgentSession['activity'] | undefined;
        let resultSummary: string | undefined;

        if (now - lastActivityMs < RUNNING_MS) {
          // 心跳活跃 → 进行中
          state = 'running';
          stateSince = lastActivityMs;
          activity = describeLiveRow(live?.row_key);
        } else {
          // 活动已停 → 完成未读（只保留 2h 窗口内）
          if (now - lastActivityMs > DONE_WINDOW_MS) continue;
          state = 'done_unread';
          stateSince = lastActivityMs;
          resultSummary = latestResultSummary(messagesBySession.get(s.id) ?? []);
        }

        const title = cleanDevinTitle(s.title, projectName(s.working_directory) || '未命名对话');

        out.push({
          key: `devin:${s.id}`,
          agent: this.id,
          agentLabel: this.label,
          badge: this.badge,
          title,
          project: projectName(s.working_directory),
          context: buildContext(s.working_directory),
          state,
          stateSince,
          lastActivityAt: lastActivityMs,
          confidence: 'inferred',
          activity,
          unread: state === 'done_unread',
          resultSummary,
        });
      }
      return out;
    } finally {
      closeDb(db);
    }
  }
}
