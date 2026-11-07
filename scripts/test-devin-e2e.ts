/**
 * Devin 适配器 e2e：构造 sessions.db 验证状态归并与过滤规则。
 * 方案 A：只做「进行中」+「完成未读」两档，不做待确认。
 * 覆盖：心跳新鲜 → running、活动停止 → done_unread、hidden 过滤、超期过滤、
 *       （关键）不产生 waiting_user。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-devin-'));
process.env.AGENT_PULSE_DEVIN_DB = path.join(root, 'sessions.db');

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const now = Date.now();
// Devin 时间戳是秒级
const sec = (ms: number) => Math.floor(ms / 1000);

// ---------- 建库（列对齐真实 Devin sessions.db） ----------
const db = new DatabaseSync(path.join(root, 'sessions.db'));
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT, backend_type TEXT, model TEXT,
    agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT,
    main_chain_id INTEGER, shell_last_seen_index INTEGER, cogs_json TEXT,
    workspace_dirs TEXT, hidden INTEGER, metadata TEXT
  );
  CREATE TABLE live_row_times (
    session_id TEXT, row_key TEXT, started_at TEXT
  );
  CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id TEXT,
    parent_node_id TEXT, chat_message TEXT, created_at INTEGER, metadata TEXT
  );
`);

function addSession(t: {
  id: string;
  title?: string;
  cwd?: string;
  hidden?: number;
  lastActivityMs: number; // 相对 now 的绝对 ms
  liveRowKey?: string;
  lastMessage?: { role: string; text: string };
}): void {
  db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, hidden)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    t.id, t.cwd ?? 'C:\\work\\proj', 'windsurf', 'swe-2-flash-medium', 'bypass',
    sec(t.lastActivityMs), sec(t.lastActivityMs), t.title ?? '标题', t.hidden ?? 0,
  );
  if (t.liveRowKey) {
    db.prepare(`INSERT INTO live_row_times (session_id, row_key, started_at) VALUES (?,?,?)`)
      .run(t.id, t.liveRowKey, new Date(t.lastActivityMs).toISOString());
  }
  if (t.lastMessage) {
    db.prepare(`INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?,?,?,?)`)
      .run(t.id, 'n-' + t.id, JSON.stringify({ role: t.lastMessage.role, content: [{ type: 'text', text: t.lastMessage.text }] }), sec(t.lastActivityMs));
  }
}

// 1) 新鲜心跳（5 分钟内有活动）→ running
addSession({ id: 'd-running', title: '正在跑的会话', cwd: 'D:\\work\\proj-a', lastActivityMs: now - 60_000, liveRowKey: 'tool:call_abc' });
// 2) 活动停止（10 分钟前）→ done_unread
addSession({
  id: 'd-done', title: '跑完的会话', cwd: 'D:\\work\\proj-b', lastActivityMs: now - 10 * 60_000,
  lastMessage: { role: 'assistant', text: '已完成。根因是配置丢失，已补上默认值。' },
});
// 3) hidden=1 → 过滤
addSession({ id: 'd-hidden', title: '隐藏会话', cwd: 'D:\\work\\proj-c', hidden: 1, lastActivityMs: now - 60_000, liveRowKey: 'thought:xxx' });
// 4) 超期（>24h）→ 过滤
addSession({ id: 'd-stale', title: '很久以前', cwd: 'D:\\work\\proj-d', lastActivityMs: now - 30 * 60 * 60_000 });
// 5) 完成但超过 2h 窗口 → 过滤
addSession({ id: 'd-done-stale', title: '三小时前完成', cwd: 'D:\\work\\proj-e', lastActivityMs: now - 3 * 60 * 60_000, lastMessage: { role: 'assistant', text: '完成' } });

db.close();

// ---------- 跑适配器 ----------
import('../src/main/adapters/devin').then(({ DevinAdapter }) => {
  const adapter = new DevinAdapter();
  ok('detect 通过', adapter.detect() === true);
  const rows = adapter.snapshot();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const has = (id: string) => byKey.has('devin:' + id);

  ok('新鲜心跳 → running', byKey.get('devin:d-running')?.state === 'running', JSON.stringify(byKey.get('devin:d-running')?.state));
  ok('running 活动描述取自 live row', byKey.get('devin:d-running')?.activity?.label === '执行工具', byKey.get('devin:d-running')?.activity?.label);
  ok('活动停止 → done_unread', byKey.get('devin:d-done')?.state === 'done_unread', JSON.stringify(byKey.get('devin:d-done')?.state));
  ok('done 有结果摘要', (byKey.get('devin:d-done')?.resultSummary ?? '').includes('根因'), byKey.get('devin:d-done')?.resultSummary);
  ok('hidden 被过滤', !has('d-hidden'));
  ok('超期被过滤', !has('d-stale'));
  ok('完成超 2h 窗口被过滤', !has('d-done-stale'));
  ok('不产生 waiting_user', !rows.some((r) => r.state === 'waiting_user'));
  ok('项目名取自 cwd 末段', byKey.get('devin:d-running')?.project === 'proj-a', byKey.get('devin:d-running')?.project);
  ok('总条数=2', rows.length === 2, `got ${rows.length}`);
  ok('confidence 标记为 inferred', rows.every((r) => r.confidence === 'inferred'));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
