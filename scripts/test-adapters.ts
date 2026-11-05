// 适配器纯函数单测：审批差集、标题清洗、状态归并
import { analyzeEvents } from '../src/main/adapters/dsh';
import { cleanTitle, pickTitle } from '../src/main/adapters/codex';
import { reconcile } from '../src/main/reconcile';
import { AgentSession } from '../src/main/adapters/types';

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
const eq = (name: string, a: any, b: any) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ============ DSH: 审批差集 ============ */
console.log('\nDSH analyzeEvents');
{
  const lines = [
    JSON.stringify({ type: 'approval/asked', time: 1000, data: { id: 'a1', toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 需要联网' } }),
  ];
  const r = analyzeEvents(lines);
  ok('asked 未 decided → 有待审批', !!r.pendingApproval);
  eq('审批 id', r.pendingApproval?.id, 'a1');
  eq('reason 去掉 escalate 前缀', r.pendingApproval?.reason, '需要联网');
}
{
  const lines = [
    JSON.stringify({ type: 'approval/asked', time: 1000, data: { id: 'a1', toolName: 'pwsh' } }),
    JSON.stringify({ type: 'approval/decided', time: 2000, data: { id: 'a1', outcome: 'allowed-once' } }),
  ];
  ok('asked 后 decided → 无待审批', analyzeEvents(lines).pendingApproval === null);
}
{
  const lines = [
    JSON.stringify({ type: 'approval/asked', time: 1000, data: { id: 'a1' } }),
    JSON.stringify({ type: 'approval/asked', time: 2000, data: { id: 'a2' } }),
    JSON.stringify({ type: 'approval/decided', time: 3000, data: { id: 'a1' } }),
  ];
  eq('多个审批只算未决的那个', analyzeEvents(lines).pendingApproval?.id, 'a2');
}
{
  const lines = [
    JSON.stringify({ type: 'turn/start', time: 1000, data: { turn: 3 } }),
    JSON.stringify({ type: 'tool/call', time: 2000, data: { name: 'pwsh' } }),
    JSON.stringify({ type: 'turn/end', time: 3000, data: { turn: 3, reason: { kind: 'completed' } } }),
  ];
  const r = analyzeEvents(lines);
  ok('turn/end → lastTurnEnded', r.lastTurnEnded === true);
  eq('最后轮次号', r.lastTurn, 3);
  eq('工具标签映射', r.lastToolLabel, '调用 pwsh');
}
{
  const lines = [
    JSON.stringify({ type: 'turn/end', time: 1000, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/start', time: 2000, data: { turn: 2 } }),
  ];
  ok('新一轮开始 → 未结束', analyzeEvents(lines).lastTurnEnded === false);
}
{
  const lines = ['not json', '{"type":"unknown"}', JSON.stringify({ type: 'turn/end', time: 500, data: { turn: 1 } })];
  ok('坏行不崩溃', analyzeEvents(lines).lastTurn === 1);
}

/* ============ Codex: 标题清洗 ============ */
console.log('\nCodex 标题');
eq('name 优先', pickTitle({ name: '拆解V1转V2新需求', title: '# Files mentioned...', preview: 'x' }, 'fb'), '拆解V1转V2新需求');
eq(
  '无 name 时从 My request 提取',
  pickTitle({ name: null, title: '# Files mentioned by the user:\n\n## codex-clipboard-x.png: C:/t.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\n修复转换日志的标记接口', preview: null }, 'fb'),
  '修复转换日志的标记接口',
);
eq('全空回退', pickTitle({ name: null, title: null, preview: null }, '未命名对话'), '未命名对话');
eq('空白 name 视为无', pickTitle({ name: '   ', title: 'hello', preview: null }, 'fb'), 'hello');
ok('超长截断', cleanTitle('x'.repeat(200), 'fb').length <= 121);

/* ============ Reconciler ============ */
console.log('\nReconcile');
function mkStore(acks: Record<string, number> = {}, ignored: Record<string, number> = {}): any {
  return { get: () => ({ acks, ignored, alwaysOnTop: true, collapsed: false, autostart: false }) };
}
const now = 1_000_000;
function s(key: string, state: AgentSession['state'], at: number): AgentSession {
  return {
    key, agent: 'dsh', agentLabel: 'D', badge: 'D', title: key, project: 'p',
    state, stateSince: at, lastActivityAt: at, confidence: 'exact',
  };
}
{
  const r = reconcile([s('a', 'done_unread', 100), s('b', 'waiting_user', 200), s('c', 'running', 300)], [], mkStore(), now);
  eq('排序：待确认 > 进行中 > 未读', r.items.map((x) => x.key), ['b', 'c', 'a']);
  eq('计数', r.counts, { waiting: 1, running: 1, done: 1, total: 3 });
  ok('attention=true 因有待确认', r.attention === true);
}
{
  // 调度语义：同级按「进入该状态的时刻」正序 —— 等得最久的排最前
  const r = reconcile([s('a', 'running', 100), s('b', 'running', 300)], [], mkStore(), now);
  eq('同状态按等待时长倒序（等得久的在前）', r.items.map((x) => x.key), ['a', 'b']);
}
{
  // 关键回归：新活动不能把等得久的挤下去
  const r = reconcile(
    [s('old', 'waiting_user', 100), s('new', 'waiting_user', 900), s('running', 'running', 50)],
    [],
    mkStore(),
    now,
  );
  eq('待确认按等待时长排，不受新活动影响', r.items.map((x) => x.key), ['old', 'new', 'running']);
}
{
  const r = reconcile([s('a', 'done_unread', 100)], [], mkStore({ a: 200 }), now);
  eq('已读且活动不晚于 ack → 隐藏', r.items.length, 0);
}
{
  const r = reconcile([s('a', 'done_unread', 300)], [], mkStore({ a: 200 }), now);
  eq('已读但之后有新活动 → 仍显示', r.items.length, 1);
}
{
  const r = reconcile([s('a', 'running', 100)], [], mkStore({}, { a: now + 1000 }), now);
  eq('忽略未到期 → 隐藏', r.items.length, 0);
}
{
  const r = reconcile([s('a', 'running', 100)], [], mkStore({}, { a: now - 1000 }), now);
  eq('忽略已过期 → 显示', r.items.length, 1);
}
{
  const r = reconcile([], [{ id: 'codex', label: 'Codex', ok: false, count: 0 }], mkStore(), now);
  ok('空列表 attention=false', r.attention === false);
  eq('空列表 total=0', r.counts.total, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
