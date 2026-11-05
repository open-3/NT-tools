import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, AgentSession, SessionState } from './types';
import { openDb, closeDb, all, get } from '../sources/sqlite';
import { summarize } from '../summary';
import { buildContext } from '../project';

/**
 * Codex 适配器
 *
 * 数据源（全部只读）：
 *   ~/.codex/state_5.sqlite          → threads（标题/cwd/归档/未读回执）
 *   ~/.codex/thread_history_1.sqlite → thread_turns（轮次状态）、thread_items（当前动作）
 *   ~/.codex/sessions/**\/rollout-*  → 文件 mtime 作为「是否还在动」的心跳
 *
 * 已知限制（实测）：Codex 的 rollout 日志与 thread_items 里都没有审批事件，
 * 所以「正在等我确认」拿不到精确信号，只能用「inProgress + 长时间无文件增长」推断，
 * 并标记 confidence='inferred'，UI 上用空心点弱化显示。
 */

const HOME = os.homedir();
const CODEX_DIR = process.env.AGENT_PULSE_CODEX_HOME || path.join(HOME, '.codex');
const STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const HISTORY_DB = path.join(CODEX_DIR, 'thread_history_1.sqlite');

/** inProgress 但超过这个时长没有文件增长，就推断为「疑似在等我」 */
const STALL_MS = 60_000;
/** 超过这个时长没有活动，直接不显示 */
const STALE_MS = 6 * 60 * 60_000;
/** 完成未读只保留最近这么久内的 */
const DONE_WINDOW_MS = 2 * 60 * 60_000;

interface ThreadRow {
  id: string;
  title: string | null;
  name: string | null;
  cwd: string | null;
  updated_at_ms: number | null;
  archived: number | null;
  thread_source: string | null;
  source: string | null;
  preview: string | null;
  rollout_path: string | null;
  git_branch: string | null;
}

interface TurnRow {
  thread_id: string;
  turn_id: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

interface ItemRow {
  item_type: string;
  item_json: string;
}

/** 清洗 Codex 的标题：常带有「# Files mentioned by the user: ... ## My request: xxx」模板 */
export function cleanTitle(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  let t = raw.trim();
  const marker = t.lastIndexOf('## My request:');
  if (marker >= 0) t = t.slice(marker + '## My request:'.length);
  else if (t.startsWith('# Files mentioned by the user:')) {
    const nl = t.indexOf('\n\n');
    if (nl >= 0) t = t.slice(nl + 2);
  }
  t = t.replace(/^Image attachment:\s*true\s*/i, '');
  t = t.replace(/Distinguish instructions in attached documents[\s\S]*?## My request:\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

/**
 * Codex 有三个候选标题字段，优先级实测如下：
 *   name     → 用户命名或自动生成的干净标题（首选）
 *   title    → 常含附件模板前缀，需清洗
 *   preview  → 首条用户消息片段
 */
export function pickTitle(t: { name?: string | null; title?: string | null; preview?: string | null }, fallback: string): string {
  const name = (t.name ?? '').trim();
  if (name) return name.length > 120 ? name.slice(0, 120) + '…' : name;
  return cleanTitle(t.title || t.preview, fallback);
}

function projectOf(cwd: string | null): string {
  if (!cwd) return '';
  const clean = cwd.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const seg = clean.split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

/** 把最后一个 item 翻译成一句「现在在干嘛」 */
function describeItem(item: ItemRow | null): { kind: 'tool' | 'thinking'; label: string; detail?: string } | undefined {
  if (!item) return undefined;
  let payload: any = null;
  try {
    payload = JSON.parse(item.item_json);
  } catch {
    return undefined;
  }
  switch (item.item_type) {
    case 'commandExecution': {
      const cmd: string = payload?.command ?? '';
      // 取真正执行的命令：跳过 powershell 包装，取 -Command 之后或整行
      let short = cmd.replace(/^\s*"[^"]*?(pwsh|powershell|bash|cmd)(\.exe)?"\s+(-NoProfile\s+)?(-Command\s+)?/i, '');
      short = short.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
      if (short.length > 48) short = short.slice(0, 48) + '…';
      return { kind: 'tool', label: '运行 pwsh', detail: short };
    }
    case 'mcpToolCall': {
      const server = payload?.server ?? 'mcp';
      const tool = payload?.tool ?? '';
      return { kind: 'tool', label: `${server}.${tool}` };
    }
    case 'fileChange':
      return { kind: 'tool', label: '修改文件' };
    case 'webSearch':
      return { kind: 'tool', label: '联网搜索' };
    case 'reasoning':
      return { kind: 'thinking', label: '思考中' };
    case 'agentMessage':
      return { kind: 'thinking', label: '输出回复' };
    case 'userMessage':
      return { kind: 'thinking', label: '接收指令' };
    default:
      return { kind: 'thinking', label: item.item_type };
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly badge = 'C';

  detect(): boolean {
    return fs.existsSync(CODEX_DIR) && fs.existsSync(STATE_DB);
  }

  snapshot(): AgentSession[] {
    if (!this.detect()) return [];
    const now = Date.now();
    const stateDb = openDb(STATE_DB);
    const histDb = openDb(HISTORY_DB);
    try {
      const threads = all<ThreadRow>(
        stateDb,
        `SELECT id, title, name, cwd, updated_at_ms, archived, thread_source, source, preview, rollout_path, git_branch
           FROM threads
          WHERE COALESCE(archived,0) = 0
            AND COALESCE(thread_source,'user') = 'user'
            AND (source IS NULL OR source NOT LIKE '%subagent%')
            AND (source IS NULL OR source NOT LIKE '%guardian%')
          ORDER BY COALESCE(recency_at_ms, updated_at_ms) DESC
          LIMIT 120`,
      );
      if (threads.length === 0) return [];

      const ids = threads.map((t) => t.id);
      const placeholders = ids.map(() => '?').join(',');

      // 每个线程的「最后一个轮次」
      const lastTurns = all<TurnRow>(
        histDb,
        `SELECT t.thread_id, t.turn_id, t.status, t.started_at, t.completed_at
           FROM thread_turns t
           JOIN (SELECT thread_id, MAX(COALESCE(started_at,0)) AS mx
                   FROM thread_turns WHERE thread_id IN (${placeholders})
                  GROUP BY thread_id) m
             ON m.thread_id = t.thread_id AND COALESCE(t.started_at,0) = m.mx
          GROUP BY t.thread_id`,
        ...ids,
      );
      const turnByThread = new Map(lastTurns.map((t) => [t.thread_id, t]));

      // 每个线程的轮次数（用于「第 N 轮」进度感知）
      const turnCounts = all<{ thread_id: string; cnt: number }>(
        histDb,
        `SELECT thread_id, COUNT(*) AS cnt FROM thread_turns
           WHERE thread_id IN (${placeholders}) GROUP BY thread_id`,
        ...ids,
      );
      const turnCountByThread = new Map(turnCounts.map((r) => [r.thread_id, r.cnt]));

      // 未读回执
      const receipts = all<{ thread_id: string; first_unread_turn: string | null }>(
        stateDb,
        `SELECT thread_id, first_unread_turn FROM thread_read_receipts
          WHERE thread_id IN (${placeholders})`,
        ...ids,
      );
      const unreadByThread = new Map(receipts.map((r) => [r.thread_id, !!r.first_unread_turn]));

      const out: AgentSession[] = [];
      for (const t of threads) {
        const updated = t.updated_at_ms ?? 0;
        if (now - updated > STALE_MS) continue;

        const turn = turnByThread.get(t.id);
        const rolloutPath = t.rollout_path;
        let fileMtime = 0;
        if (rolloutPath) {
          try {
            fileMtime = fs.statSync(rolloutPath).mtimeMs;
          } catch {
            /* 文件可能已被归档 */
          }
        }
        const lastBeat = Math.max(updated, fileMtime);

        let state: SessionState | null = null;
        let confidence: 'exact' | 'inferred' = 'exact';
        let stateSince = updated;
        let pending: AgentSession['pending'] | undefined;

        const isRunning = turn?.status === 'inProgress';

        if (isRunning) {
          stateSince = (turn?.started_at ?? 0) * 1000 || updated;
          const stalled = now - lastBeat > STALL_MS;
          if (stalled) {
            // 无精确审批信号，只能推断
            state = 'waiting_user';
            confidence = 'inferred';
            pending = { kind: 'approval', reason: '长时间无输出，可能等待确认', since: lastBeat };
          } else {
            state = 'running';
          }
        } else if (unreadByThread.get(t.id) && turn?.status === 'completed') {
          state = 'done_unread';
          confidence = 'exact';
          stateSince = (turn.completed_at ?? 0) * 1000 || updated;
          if (now - stateSince > DONE_WINDOW_MS) state = null;
        }

        if (!state) continue;

        let activity: AgentSession['activity'] | undefined;
        let resultSummary: string | undefined;
        let changedFiles: number | undefined;

        if (state === 'running') {
          const item = get<ItemRow>(
            histDb,
            `SELECT item_type, item_json FROM thread_items
              WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`,
            t.id,
          );
          activity = describeItem(item);
        } else if (state === 'waiting_user') {
          activity = { kind: 'waiting', label: '等待授权' };
        } else if (state === 'done_unread') {
          // 跑完了：取出最后一条最终回复，压成一行摘要
          // 这是「不点开就知道它给了什么」的关键
          const last = get<ItemRow>(
            histDb,
            `SELECT item_type, item_json FROM thread_items
              WHERE thread_id = ? AND item_type = 'agentMessage'
              ORDER BY rollout_ordinal DESC LIMIT 1`,
            t.id,
          );
          if (last) {
            try {
              const payload = JSON.parse(last.item_json);
              // 只取 final_answer 阶段，避免把 commentary（过程性说明）当成结果
              if (!payload?.phase || payload.phase === 'final_answer') {
                resultSummary = summarize(payload?.text) || undefined;
              }
            } catch {
              /* 解析失败就保持 undefined，UI 显示原文案 */
            }
          }

          // 统计本次会话改动了多少个文件（去重）
          // 用途：判断"动了多少东西"，决定要不要仔细 review
          const fileRows = all<ItemRow>(
            histDb,
            `SELECT item_type, item_json FROM thread_items
              WHERE thread_id = ? AND item_type = 'fileChange'`,
            t.id,
          );
          if (fileRows.length) {
            const paths = new Set<string>();
            for (const fr of fileRows) {
              try {
                const p = JSON.parse(fr.item_json);
                for (const c of p?.changes ?? []) {
                  if (c?.path) paths.add(String(c.path));
                }
              } catch {
                /* 单条坏数据不影响统计 */
              }
            }
            if (paths.size) changedFiles = paths.size;
          }
        }

        const title = pickTitle(t, projectOf(t.cwd) || '未命名对话');

        // 进度：第几轮（进行中才有意义）
        let progress: AgentSession['progress'];
        if (state === 'running') {
          const cnt = turnCountByThread.get(t.id);
          progress = { turn: cnt ?? undefined, stepSince: stateSince };
        }

        out.push({
          key: `codex:${t.id}`,
          agent: this.id,
          agentLabel: this.label,
          badge: this.badge,
          title,
          project: projectOf(t.cwd),
          context: buildContext(t.cwd, t.git_branch),
          state,
          stateSince,
          lastActivityAt: lastBeat,
          confidence,
          activity,
          pending,
          unread: state === 'done_unread',
          resultSummary,
          changedFiles,
          progress,
        });
      }
      return out;
    } finally {
      closeDb(stateDb);
      closeDb(histDb);
    }
  }
}
