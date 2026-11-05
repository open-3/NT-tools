/**
 * 用构造的 sqlite 库跑真实 Codex 适配器，验证状态归并与过滤规则。
 * 覆盖：inProgress 新鲜 → running、inProgress 停滞 → waiting_user(inferred)、
 *       未读回执 + completed → done_unread、guardian/subagent 线程被过滤、归档被过滤。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-codex-'));
process.env.AGENT_PULSE_CODEX_HOME = root;

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
const sec = (ms: number) => Math.floor(ms / 1000);

// ---------- 建库 ----------
const stateDb = new DatabaseSync(path.join(root, 'state_5.sqlite'));
stateDb.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
    source TEXT, model_provider TEXT, cwd TEXT, title TEXT, sandbox_policy TEXT,
    approval_mode TEXT, tokens_used INTEGER, has_user_event INTEGER, archived INTEGER,
    archived_at INTEGER, thread_source TEXT, name TEXT, preview TEXT,
    updated_at_ms INTEGER, recency_at_ms INTEGER, git_branch TEXT
  );
  CREATE TABLE thread_read_receipts (
    thread_id TEXT PRIMARY KEY, first_unread_turn TEXT, revision TEXT, last_published_turn TEXT
  );
`);
const histDb = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
histDb.exec(`
  CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT,
    started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
    first_user_item_id TEXT, final_agent_item_id TEXT,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    created_at_ms INTEGER, item_json TEXT, item_type TEXT,
    updated_at_ordinal INTEGER DEFAULT 0, started_at_ms INTEGER, completed_at_ms INTEGER,
    PRIMARY KEY (thread_id, turn_id, item_id)
  );
`);

const rolloutDir = path.join(root, 'sessions');
fs.mkdirSync(rolloutDir, { recursive: true });

function addThread(t: {
  id: string;
  title?: string;
  name?: string | null;
  cwd: string;
  source?: string;
  threadSource?: string;
  archived?: number;
  updatedAt: number;
  /** 最后一轮 */
  turn?: { status: string; startedAt: number; completedAt?: number | null };
  unread?: boolean;
  lastItem?: { type: string; json: any };
  /** rollout 文件的 mtime（相对 now 的毫秒偏移，负值表示过去） */
  fileAgeMs?: number;
}): void {
  const rollout = path.join(rolloutDir, `${t.id}.jsonl`);
  fs.writeFileSync(rollout, '');
  if (t.fileAgeMs !== undefined) {
    const d = new Date(now + t.fileAgeMs);
    fs.utimesSync(rollout, d, d);
  }

  stateDb
    .prepare(
      `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, thread_source, name, preview,
        updated_at_ms, recency_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      t.id, rollout, sec(t.updatedAt), sec(t.updatedAt), t.source ?? 'vscode', 'openai', t.cwd,
      t.title ?? '标题', '{}', 'on-request', 0, 1, t.archived ?? 0, t.threadSource ?? 'user',
      t.name ?? null, t.title ?? null, t.updatedAt, t.updatedAt,
    );

  if (t.turn) {
    histDb
      .prepare(`INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) VALUES (?,?,?,?,?,?)`)
      .run(t.id, t.id + '-turn', 1, t.turn.status, sec(t.turn.startedAt), t.turn.completedAt ? sec(t.turn.completedAt) : null);
  }
  if (t.lastItem) {
    histDb
      .prepare(`INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?,?,?,?,?,?,?)`)
      .run(t.id, t.id + '-turn', 'it1', 99, now, JSON.stringify(t.lastItem.json), t.lastItem.type);
  }
  if (t.unread) {
    stateDb.prepare(`INSERT INTO thread_read_receipts (thread_id, first_unread_turn, revision, last_published_turn) VALUES (?,?,?,?)`)
      .run(t.id, 'turn-x', 'rev', 'turn-x');
  }
}

// 1) 新鲜的进行中（rollout 刚刚写过）→ running
addThread({
  id: 'th-running', name: '正在跑的会话', cwd: 'D:\\work\\proj-a',
  updatedAt: now - 2000, fileAgeMs: -1000,
  turn: { status: 'inProgress', startedAt: now - 30000 },
  lastItem: { type: 'commandExecution', json: { type: 'commandExecution', command: '"C:\\pwsh.exe" -NoProfile -Command "npm run build"' } },
});
// 2) 进行中但 90s 无文件增长 → waiting_user(inferred)
addThread({
  id: 'th-stalled', name: '疑似卡住的会话', cwd: 'D:\\work\\proj-b',
  updatedAt: now - 120000, fileAgeMs: -90000,
  turn: { status: 'inProgress', startedAt: now - 200000 },
});
// 3) 已完成 + 未读 → done_unread
addThread({
  id: 'th-done', name: '跑完没看的会话', cwd: 'D:\\work\\proj-c',
  updatedAt: now - 600000, fileAgeMs: -600000, unread: true,
  turn: { status: 'completed', startedAt: now - 700000, completedAt: now - 600000 },
});
// 4) 已完成但已读 → 不显示
addThread({
  id: 'th-read', name: '跑完已读的会话', cwd: 'D:\\work\\proj-d',
  updatedAt: now - 600000, fileAgeMs: -600000, unread: false,
  turn: { status: 'completed', startedAt: now - 700000, completedAt: now - 600000 },
});
// 5) guardian 审查线程 → 必须过滤
addThread({
  id: 'th-guardian', name: 'Guardian review', cwd: 'D:\\work\\proj-a',
  threadSource: 'guardian_review', updatedAt: now - 1000, fileAgeMs: -1000,
  turn: { status: 'inProgress', startedAt: now - 5000 },
});
// 6) subagent 来源 → 必须过滤
addThread({
  id: 'th-sub', name: '子 agent', cwd: 'D:\\work\\proj-a',
  source: '{"subagent":{"other":"guardian"}}', updatedAt: now - 1000, fileAgeMs: -1000,
  turn: { status: 'inProgress', startedAt: now - 5000 },
});
// 7) 已归档 → 必须过滤
addThread({
  id: 'th-archived', name: '已归档', cwd: 'D:\\work\\proj-a', archived: 1,
  updatedAt: now - 1000, fileAgeMs: -1000,
  turn: { status: 'inProgress', startedAt: now - 5000 },
});
// 8) 超过 6 小时 → 不显示
addThread({
  id: 'th-stale', name: '很久以前', cwd: 'D:\\work\\proj-e',
  updatedAt: now - 10 * 3600_000, fileAgeMs: -10 * 3600_000,
  turn: { status: 'inProgress', startedAt: now - 10 * 3600_000 },
});

stateDb.close();
histDb.close();

// ---------- 跑适配器 ----------
import('../src/main/adapters/codex').then(({ CodexAdapter }) => {
  const adapter = new CodexAdapter();
  ok('detect 通过', adapter.detect() === true);
  const rows = adapter.snapshot();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const has = (id: string) => byKey.has('codex:' + id);

  ok('新鲜的进行中 → running', byKey.get('codex:th-running')?.state === 'running', JSON.stringify(byKey.get('codex:th-running')?.state));
  ok('running 的活动描述取自最后 item', (byKey.get('codex:th-running')?.activity?.detail ?? '').includes('npm run build'), byKey.get('codex:th-running')?.activity?.detail);
  ok('停滞的进行中 → waiting_user', byKey.get('codex:th-stalled')?.state === 'waiting_user', JSON.stringify(byKey.get('codex:th-stalled')?.state));
  ok('停滞态标记为 inferred', byKey.get('codex:th-stalled')?.confidence === 'inferred');
  ok('完成未读 → done_unread', byKey.get('codex:th-done')?.state === 'done_unread');
  ok('完成已读 → 不显示', !has('th-read'));
  ok('guardian 线程被过滤', !has('th-guardian'));
  ok('subagent 线程被过滤', !has('th-sub'));
  ok('归档线程被过滤', !has('th-archived'));
  ok('超期线程被过滤', !has('th-stale'));
  ok('总条数=3', rows.length === 3, `got ${rows.length}`);
  ok('标题用 name 字段', byKey.get('codex:th-running')?.title === '正在跑的会话', byKey.get('codex:th-running')?.title);
  ok('项目名取自 cwd 末段', byKey.get('codex:th-running')?.project === 'proj-a', byKey.get('codex:th-running')?.project);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
