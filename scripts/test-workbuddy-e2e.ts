/**
 * WorkBuddy 适配器端到端测试：构造真实的 workbuddy.db（含 sessions 表），
 * 验证状态映射、未读、软删除、后台任务过滤、双版本合并。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-wb-'));
const cnDir = path.join(root, '.workbuddy');
const aiDir = path.join(root, '.workbuddy-ai');

// 适配器用 os.homedir() 拼路径，测试里用 HOME 重定向
process.env.HOME = root;
process.env.USERPROFILE = root;

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

function createDb(dir: string, rows: Array<Partial<Record<string, any>> & { id: string }>): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'workbuddy.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT 'u',
      title TEXT,
      custom_title TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      last_activity_at INTEGER,
      deleted_at INTEGER,
      is_playground INTEGER NOT NULL DEFAULT 0,
      source_mode TEXT,
      is_background_automation INTEGER,
      mode TEXT,
      model TEXT,
      permission_mode TEXT,
      transport TEXT NOT NULL DEFAULT 'local',
      unread INTEGER NOT NULL DEFAULT 0
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at,
       last_activity_at, deleted_at, is_background_automation, permission_mode, mode, unread)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.cwd ?? 'D:\\work\\proj',
      r.title ?? '标题',
      r.custom_title ?? null,
      r.status ?? 'completed',
      r.created_at ?? now - 600000,
      r.updated_at ?? now - 60000,
      r.last_activity_at ?? now - 60000,
      r.deleted_at ?? null,
      r.is_background_automation ?? 0,
      r.permission_mode ?? 'bypassPermissions',
      r.mode ?? 'craft',
      r.unread ?? 0,
    );
  }
  db.close();
}

createDb(cnDir, [
  // 待确认：状态机 pending
  { id: 'cn-pending', title: '等待授权的会话', status: 'pending', last_activity_at: now - 30000 },
  // 进行中
  { id: 'cn-working', title: '正在跑的会话', status: 'working', last_activity_at: now - 5000 },
  // 规划中
  { id: 'cn-planning', title: '规划中的会话', status: 'planning', last_activity_at: now - 8000 },
  // 完成 + 未读
  { id: 'cn-done-unread', title: '跑完没看', status: 'completed', unread: 1, last_activity_at: now - 120000, updated_at: now - 120000 },
  // 完成 + 已读 → 不显示
  { id: 'cn-done-read', title: '跑完已读', status: 'completed', unread: 0, last_activity_at: now - 120000 },
  // 软删除 → 不显示
  { id: 'cn-deleted', title: '已删除', status: 'pending', deleted_at: now - 1000 },
  // 后台自动化 → 不显示
  { id: 'cn-bg', title: '后台任务', status: 'working', is_background_automation: 1 },
  // 超期 → 不显示
  { id: 'cn-stale', title: '很久以前', status: 'working', last_activity_at: now - 10 * 3600_000, updated_at: now - 10 * 3600_000 },
  // custom_title 优先
  { id: 'cn-custom', title: '原始标题', custom_title: '我改过的名字', status: 'working', last_activity_at: now - 2000 },
  // 大写 Pending（表默认值）也要识别
  { id: 'cn-upper', title: '大写Pending', status: 'Pending', last_activity_at: now - 4000 },
]);

createDb(aiDir, [
  { id: 'ai-working', title: 'AI 版会话', status: 'working', last_activity_at: now - 3000 },
]);

import('../src/main/adapters/workbuddy').then(({ WorkBuddyAdapter, __test__ }) => {
  const adapter = new WorkBuddyAdapter();
  ok('detect 通过（两版本都检测到）', adapter.detect() === true);

  const rows = adapter.snapshot();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const has = (k: string) => byKey.has(k);

  ok('pending → waiting_user', byKey.get('wb-cn:cn-pending')?.state === 'waiting_user', byKey.get('wb-cn:cn-pending')?.state);
  ok('pending 置信度为 exact', byKey.get('wb-cn:cn-pending')?.confidence === 'exact');
  ok('pending 带 approval 信息', byKey.get('wb-cn:cn-pending')?.pending?.kind === 'approval');
  ok('working → running', byKey.get('wb-cn:cn-working')?.state === 'running');
  ok('planning → running', byKey.get('wb-cn:cn-planning')?.state === 'running');
  ok('completed+unread → done_unread', byKey.get('wb-cn:cn-done-unread')?.state === 'done_unread');
  ok('completed+已读 → 不显示', !has('wb-cn:cn-done-read'));
  ok('软删除 → 不显示', !has('wb-cn:cn-deleted'));
  ok('后台自动化 → 不显示', !has('wb-cn:cn-bg'));
  ok('超期 → 不显示', !has('wb-cn:cn-stale'));
  ok('custom_title 优先', byKey.get('wb-cn:cn-custom')?.title === '我改过的名字', byKey.get('wb-cn:cn-custom')?.title);
  ok('大写 Pending 也能识别', byKey.get('wb-cn:cn-upper')?.state === 'waiting_user', byKey.get('wb-cn:cn-upper')?.state);

  ok('国际版会话被合并进来', byKey.get('wb-ai:ai-working')?.state === 'running');
  ok('两版本 key 前缀区分', byKey.get('wb-cn:cn-working')?.agent === 'wb-cn' && byKey.get('wb-ai:ai-working')?.agent === 'wb-ai');

  ok('总条数=7', rows.length === 7, `got ${rows.length}: ${rows.map((r) => r.key).join(',')}`);

  // 纯函数
  ok('normalizeStatus 小写化', __test__.normalizeStatus('Pending') === 'pending');
  ok('normalizeStatus 处理 null', __test__.normalizeStatus(null) === '');
  ok('mapState pending', __test__.mapState('pending', false) === 'waiting_user');
  ok('mapState completed+read → null', __test__.mapState('completed', false) === null);
  ok('mapState failed+unread → done_unread', __test__.mapState('failed', true) === 'done_unread');
  ok('projectOf 取末段', __test__.projectOf('D:\\a\\b\\proj-x') === 'proj-x');
  ok('projectOf 去 \\\\?\\ 前缀', __test__.projectOf('\\\\?\\D:\\a\\proj-y') === 'proj-y');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
