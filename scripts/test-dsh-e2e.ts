/**
 * 用构造出来的假 DSH 目录跑真实适配器，验证「待确认」这条最关键的判定链路。
 * 覆盖：未决审批 → waiting_user(exact)、已决审批 → 不算待确认、
 *       openStep → running、turn/end → done_unread。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-dsh-'));
process.env.AGENT_PULSE_DSH_HOME = root;

const sessionsDir = path.join(root, 'sessions', '--proj--');
const projDir = path.join(root, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(projDir, { recursive: true });

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

interface Case {
  id: string;
  title: string;
  events: any[];
  proj: any;
  expect: 'waiting_user' | 'running' | 'done_unread' | null;
  expectConfidence?: 'exact' | 'inferred';
  expectReason?: string;
}

const now = Date.now();
const t = (offsetMin: number) => now - offsetMin * 60_000;

const cases: Case[] = [
  {
    id: 'session-aaaa1111-0000-0000-0000-000000000001',
    title: '未决审批的会话',
    events: [
      { type: 'turn/start', seq: 1, time: t(3), data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: t(2), data: { name: 'pwsh' } },
      { type: 'approval/asked', seq: 3, time: t(2), data: { id: 'ap1', toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 需要访问本地浏览器' } },
    ],
    proj: { openStep: { turn: 1, step: 3, startTime: t(2) }, openTurnStartSeq: 1 },
    expect: 'waiting_user',
    expectConfidence: 'exact',
    expectReason: '需要访问本地浏览器',
  },
  {
    id: 'session-bbbb2222-0000-0000-0000-000000000002',
    title: '已批准继续跑的会话',
    events: [
      { type: 'turn/start', seq: 1, time: t(4), data: { turn: 1 } },
      { type: 'approval/asked', seq: 2, time: t(4), data: { id: 'ap2', toolName: 'pwsh', reason: '需要联网' } },
      { type: 'approval/decided', seq: 3, time: t(3), data: { id: 'ap2', outcome: 'allowed-once' } },
      { type: 'tool/call', seq: 4, time: t(1), data: { name: 'read' } },
    ],
    proj: { openStep: { turn: 1, step: 5, startTime: t(1) }, openTurnStartSeq: 1 },
    expect: 'running',
  },
  {
    id: 'session-cccc3333-0000-0000-0000-000000000003',
    title: '刚跑完的会话',
    events: [
      { type: 'turn/start', seq: 1, time: t(20), data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: t(19), data: { name: 'write' } },
      { type: 'assistant/message', seq: 3, time: t(18), data: {} },
      { type: 'turn/end', seq: 4, time: t(18), data: { turn: 1, reason: { kind: 'completed' } } },
    ],
    proj: { openStep: null, openTurnStartSeq: null },
    expect: 'done_unread',
    expectConfidence: 'exact',
  },
  {
    id: 'session-dddd4444-0000-0000-0000-000000000004',
    title: '等待回答的会话',
    events: [
      { type: 'turn/start', seq: 1, time: t(6), data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: t(6), data: { name: 'ask_user_question' } },
    ],
    proj: {
      openStep: { turn: 1, step: 2, startTime: t(6) },
      openTurnStartSeq: 1,
      userQuestions: { questions: { active: [{ id: 'q1' }], settled: [] } },
    },
    expect: 'waiting_user',
    expectConfidence: 'exact',
    expectReason: '等待回答',
  },
  {
    id: 'session-eeee5555-0000-0000-0000-000000000005',
    title: '很久以前的会话',
    events: [
      { type: 'turn/start', seq: 1, time: t(60 * 10), data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: t(60 * 9), data: { turn: 1 } },
    ],
    proj: { openStep: null, openTurnStartSeq: null },
    expect: null, // 超过 6 小时 stale 阈值，不该显示
  },
];

function writeCase(c: Case): void {
  const dir = path.join(sessionsDir, c.id);
  fs.mkdirSync(dir, { recursive: true });

  // 多帧 zstd：模拟 DSH 真实写入方式（每帧一段 JSONL）
  const lines = c.events.map((e) => JSON.stringify(e));
  const frames: Buffer[] = [];
  for (const line of lines) {
    frames.push(zstdCompressSync(Buffer.from(line + '\n', 'utf8')));
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

  const proj = {
    version: 7,
    record: {
      rows: {
        title: { val: c.title },
        workingDirectory: { val: '/home/user/proj-x' },
        sessionStats: { val: { openStep: c.proj.openStep, pendingCalls: {} } },
        turnBoundary: { val: { openTurnStartSeq: c.proj.openTurnStartSeq ?? null } },
        sessionListMetadata: { val: { lastPromptAt: c.events[0]?.time ?? now } },
        userQuestions: { val: c.proj.userQuestions ?? { questions: { active: [], settled: [] } } },
      },
    },
  };
  fs.writeFileSync(path.join(projDir, c.id + '.json'), JSON.stringify(proj));
}

// 让文件 mtime 看起来是最近的（适配器用 mtime 判断新鲜度）
function touchRecent(p: string): void {
  const d = new Date();
  fs.utimesSync(p, d, d);
}

for (const c of cases) writeCase(c);
// 把所有 session 文件 mtime 设为现在（除 stale 那条）
for (const c of cases) {
  if (c.expect === null) continue;
  touchRecent(path.join(sessionsDir, c.id, 'session.v4.jsonl.zstd'));
}
// stale 那条保持旧 mtime
const stalePath = path.join(sessionsDir, cases[4].id, 'session.v4.jsonl.zstd');
const old = new Date(now - 10 * 3600_000);
fs.utimesSync(stalePath, old, old);

// 现在才 import，确保 env 已设置
import('../src/main/adapters/dsh').then(({ DshAdapter }) => {
  const adapter = new DshAdapter();
  ok('detect 通过', adapter.detect() === true);
  const rows = adapter.snapshot();
  const byTitle = new Map(rows.map((r) => [r.title, r]));

  for (const c of cases) {
    const row = byTitle.get(c.title);
    if (c.expect === null) {
      ok(`[${c.title}] 超期不显示`, row === undefined, row ? `got ${row.state}` : '');
      continue;
    }
    if (!row) {
      ok(`[${c.title}] 应显示`, false, 'not found');
      continue;
    }
    ok(`[${c.title}] 状态=${c.expect}`, row.state === c.expect, `got ${row.state}`);
    if (c.expectConfidence) {
      ok(`[${c.title}] 置信度=${c.expectConfidence}`, row.confidence === c.expectConfidence, `got ${row.confidence}`);
    }
    if (c.expectReason) {
      ok(`[${c.title}] 理由="${c.expectReason}"`, row.pending?.reason === c.expectReason, `got "${row.pending?.reason}"`);
    }
  }

  ok('总条数=4（排除 stale）', rows.length === 4, `got ${rows.length}`);

  // 清理
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
