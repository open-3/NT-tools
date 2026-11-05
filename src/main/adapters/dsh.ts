import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, AgentSession, SessionState } from './types';
import { readSessionLines, safeParse } from '../sources/zstd';
import { summarize, extractDshText } from '../summary';
import { buildContext } from '../project';

/**
 * DeepSeek Harness 适配器
 *
 * 数据源（全部只读）：
 *   ~/.dsh/storages/session_projcache/sessions/*.json  → 实时投影：标题/是否在跑/待回答
 *   ~/.dsh/sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd → 事件流：审批差集、轮次结束
 *   ~/.dsh/storages/workspace.json → 工作区归属
 *
 * DSH 的信号比 Codex 精确得多：
 *   openStep != null            → 确切的「进行中」
 *   approval/asked 无 decided   → 确切的「待我确认」
 */

const HOME = os.homedir();
const DSH_DIR = process.env.AGENT_PULSE_DSH_HOME || path.join(HOME, '.dsh');
const SESSIONS_DIR = path.join(DSH_DIR, 'sessions');
const PROJ_DIR = path.join(DSH_DIR, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_JSON = path.join(DSH_DIR, 'storages', 'workspace.json');

const STALE_MS = 6 * 60 * 60_000;
const DONE_WINDOW_MS = 2 * 60 * 60_000;

interface ProjCache {
  record?: {
    rows?: Record<string, { val?: any }>;
  };
}

interface Parsed {
  title: string;
  cwd: string;
  lastPromptAt: number;
  openStep: any;
  openTurnStartSeq: number | null;
  activeQuestions: number;
  lastEventType: string;
  lastEventTime: number;
  /** 已 asked 未 decided 的审批 */
  pendingApproval: { id: string; toolName?: string; reason?: string; since: number } | null;
  /** 最后一轮是否已结束 */
  lastTurnEnded: boolean;
  lastTurn: number;
  lastToolLabel: string;
  /** 最后一条助手正文，用于结果摘要 */
  lastAssistantText: string;
}

function readProj(file: string): ProjCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjCache;
  } catch {
    return null;
  }
}

function findSessionFile(sessionId: string): string | null {
  try {
    for (const slug of fs.readdirSync(SESSIONS_DIR)) {
      const dir = path.join(SESSIONS_DIR, slug, sessionId);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('session.') && (f.endsWith('.zstd') || f.endsWith('.jsonl'))) {
          return path.join(dir, f);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

const TOOL_LABEL: Record<string, string> = {
  pwsh: '调用 pwsh',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  grep: '搜索代码',
  glob: '查找文件',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  subagent: '派生子 agent',
  todo_write: '更新任务',
};

export function analyzeEvents(lines: string[]): Partial<Parsed> {
  const asked = new Map<string, { toolName?: string; reason?: string; time: number }>();
  const decided = new Set<string>();
  let lastEventType = '';
  let lastEventTime = 0;
  let lastTurnEnded = false;
  let lastTurn = 0;
  let lastToolLabel = '';
  let lastAssistantText = '';

  for (const line of lines) {
    const ev = safeParse<any>(line);
    if (!ev || typeof ev.type !== 'string') continue;
    const t = typeof ev.time === 'number' ? ev.time : 0;
    if (t >= lastEventTime) {
      lastEventTime = t;
      lastEventType = ev.type;
    }
    switch (ev.type) {
      case 'approval/asked': {
        const d = ev.data ?? {};
        if (d.id) asked.set(String(d.id), { toolName: d.toolName, reason: d.reason, time: t });
        break;
      }
      case 'approval/decided': {
        const d = ev.data ?? {};
        if (d.id) decided.add(String(d.id));
        break;
      }
      case 'tool/call': {
        const name = ev.data?.name ?? '';
        lastToolLabel = TOOL_LABEL[name] ?? `调用 ${name}`;
        break;
      }
      case 'assistant/message': {
        // 只保留最后一条有正文的助手消息，用于结果摘要。
        // 注意 extractDshText 会排除 reasoning 块，否则会把思考过程当结果。
        const txt = extractDshText(ev.data?.message);
        if (txt) lastAssistantText = txt;
        break;
      }
      case 'turn/end': {
        lastTurnEnded = true;
        lastTurn = ev.data?.turn ?? lastTurn;
        break;
      }
      case 'turn/start': {
        lastTurnEnded = false;
        lastTurn = ev.data?.turn ?? lastTurn;
        // 新一轮开始，清掉上一轮的结果，避免显示过期的摘要
        lastAssistantText = '';
        break;
      }
      default:
        break;
    }
  }

  let pendingApproval: Parsed['pendingApproval'] = null;
  for (const [id, info] of asked) {
    if (!decided.has(id)) {
      pendingApproval = { id, toolName: info.toolName, reason: cleanReason(info.reason), since: info.time };
    }
  }

  return { lastEventType, lastEventTime, lastTurnEnded, lastTurn, pendingApproval, lastToolLabel, lastAssistantText };
}

/**
 * 审批理由里常带一段机械前缀（如 "escalate sandbox to danger-full-access: "），
 * 真正的理由在其后。这里统一剥离，避免 UI 上显示一长串无意义前缀。
 */
export function cleanReason(reason: string | undefined): string | undefined {
  if (!reason) return reason;
  const cleaned = reason
    .replace(/^escalate sandbox to [^:]+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned;
}

function projectFromCwd(cwd: string): string {
  if (!cwd) return '';
  const seg = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly label = 'DeepSeek Harness';
  readonly badge = 'D';

  detect(): boolean {
    return fs.existsSync(DSH_DIR) && fs.existsSync(PROJ_DIR);
  }

  snapshot(): AgentSession[] {
    if (!this.detect()) return [];
    const now = Date.now();

    let files: string[] = [];
    try {
      files = fs.readdirSync(PROJ_DIR).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
    } catch {
      return [];
    }

    const out: AgentSession[] = [];
    for (const file of files) {
      const proj = readProj(path.join(PROJ_DIR, file));
      const rows = proj?.record?.rows ?? {};
      const val = (k: string) => rows[k]?.val;

      const title = (val('title') as string) || '';
      const cwd = (val('workingDirectory') as string) || '';
      const stats = val('sessionStats') ?? {};
      const boundary = val('turnBoundary') ?? {};
      const meta = val('sessionListMetadata') ?? {};
      const questions = (val('userQuestions') ?? {}).questions ?? {};
      const activeQ = Array.isArray(questions.active) ? questions.active.length : 0;
      const openStep = stats.openStep ?? null;
      const openTurn = boundary.openTurnStartSeq ?? null;
      const lastPromptAt: number = meta.lastPromptAt ?? 0;

      const sessionId = file.replace(/\.json$/, '');

      // 判断是否在跑：openStep 或 openTurn 是最直接的信号
      const runningByProj = openStep != null || openTurn != null;

      // 需要看事件流才能判断「待审批」与「刚跑完」
      let parsed: Partial<Parsed> = {};
      const sessFile = findSessionFile(sessionId);
      let fileMtime = 0;
      if (sessFile) {
        try {
          fileMtime = fs.statSync(sessFile).mtimeMs;
          const buf = fs.readFileSync(sessFile);
          const lines = readSessionLines(sessFile, buf, 40);
          parsed = analyzeEvents(lines);
        } catch {
          /* 读不到就退化到 projcache 信号 */
        }
      }

      const lastActivity = Math.max(lastPromptAt, fileMtime, parsed.lastEventTime ?? 0);
      if (now - lastActivity > STALE_MS) continue;

      let state: SessionState | null = null;
      let confidence: 'exact' | 'inferred' = 'exact';
      let stateSince = lastActivity;
      let pending: AgentSession['pending'] | undefined;
      let activity: AgentSession['activity'] | undefined;
      let resultSummary: string | undefined;

      const pendingApproval = parsed.pendingApproval ?? null;

      if (pendingApproval) {
        state = 'waiting_user';
        confidence = 'exact';
        stateSince = pendingApproval.since || lastActivity;
        pending = {
          kind: 'approval',
          reason: pendingApproval.reason || '等待授权',
          since: stateSince,
        };
        activity = { kind: 'waiting', label: '等待授权' };
      } else if (activeQ > 0) {
        state = 'waiting_user';
        confidence = 'exact';
        pending = { kind: 'question', reason: '等待回答', since: lastActivity };
        activity = { kind: 'waiting', label: '等待回答' };
      } else if (runningByProj) {
        state = 'running';
        stateSince = openStep?.startTime ?? lastActivity;
        const label = parsed.lastToolLabel || (openStep?.firstTokenTime ? '生成回复' : '思考中');
        activity = { kind: 'tool', label };
      } else if (parsed.lastTurnEnded && (parsed.lastTurn ?? 0) > 0) {
        state = 'done_unread';
        confidence = 'exact';
        stateSince = parsed.lastEventTime || lastActivity;
        if (now - stateSince > DONE_WINDOW_MS) state = null;
        else resultSummary = summarize(parsed.lastAssistantText) || undefined;
      }

      if (!state) continue;

      // 进度：第几轮（进行中才有意义）。DSH 的 turns 是累计回合数，精确。
      let progress: AgentSession['progress'];
      if (state === 'running') {
        progress = {
          turn: stats.turns ?? undefined,
          stepSince: openStep?.startTime ?? stateSince,
        };
      }

      out.push({
        key: `dsh:${sessionId}`,
        agent: this.id,
        agentLabel: this.label,
        badge: this.badge,
        title: title || projectFromCwd(cwd) || '未命名对话',
        project: projectFromCwd(cwd),
        context: buildContext(cwd),
        state,
        stateSince,
        lastActivityAt: lastActivity,
        confidence,
        activity,
        pending,
        unread: state === 'done_unread',
        resultSummary,
        progress,
      });
    }
    return out;
  }
}
