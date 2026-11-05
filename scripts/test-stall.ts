// 停滞感知 / 进度 / 过期的纯函数单测
import { stallLevelOf, DONE_WINDOW_MS, reconcile } from '../src/main/reconcile';
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
const eq = (name: string, a: any, b: any) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

function base(over: Partial<AgentSession>): AgentSession {
  return {
    key: 'codex:x',
    agent: 'codex',
    agentLabel: 'Codex',
    badge: 'C',
    title: 't',
    project: 'p',
    state: 'running',
    stateSince: 0,
    lastActivityAt: 0,
    confidence: 'exact',
    ...over,
  };
}

/* ============ stallLevelOf ============ */
console.log('\nstallLevelOf');
{
  const now = 1_000_000_000;
  // 刚活动过 → ok
  eq('5 分钟前活动 → ok', stallLevelOf(base({ lastActivityAt: now - 5 * 60_000 }), now), 'ok');
  // 10 分钟整 → 边界归 stall（>= STALL_STALL_MS）
  eq('10 分钟 → stall', stallLevelOf(base({ lastActivityAt: now - 10 * 60_000 }), now), 'stall');
  // 30 分钟 → stall
  eq('30 分钟 → stall', stallLevelOf(base({ lastActivityAt: now - 30 * 60_000 }), now), 'stall');
  // 60 分钟整 → stuck
  eq('60 分钟 → stuck', stallLevelOf(base({ lastActivityAt: now - 60 * 60_000 }), now), 'stuck');
  // 3 小时 → stuck
  eq('3 小时 → stuck', stallLevelOf(base({ lastActivityAt: now - 3 * 3600_000 }), now), 'stuck');
}
{
  const now = 1_000_000_000;
  // 非 running 状态不参与分级
  eq('waiting 不分级', stallLevelOf(base({ state: 'waiting_user', lastActivityAt: now - 3 * 3600_000 }), now), undefined);
  eq('done 不分级', stallLevelOf(base({ state: 'done_unread', lastActivityAt: now - 3 * 3600_000 }), now), undefined);
}

/* ============ reconcile 注入 stallLevel ============ */
console.log('\nreconcile 注入 stallLevel');
{
  const now = 1_700_000_000_000;
  const nowMinAgo = now - 45 * 60_000;
  const s = base({ lastActivityAt: nowMinAgo, stateSince: nowMinAgo });
  const snap = reconcile([s], [], { get: () => ({ acks: {}, ignored: {}, collapsed: false, alwaysOnTop: true, window: {} }) } as any, now);
  eq('running 45 分钟没动 → stallLevel=stall', snap.items[0].stallLevel, 'stall');
}
{
  const now = 1_700_000_000_000;
  const nowMinAgo = now - 60_000; // 刚动过
  const s = base({ lastActivityAt: nowMinAgo, stateSince: nowMinAgo });
  const snap = reconcile([s], [], { get: () => ({ acks: {}, ignored: {}, collapsed: false, alwaysOnTop: true, window: {} }) } as any, now);
  eq('running 1 分钟前动过 → stallLevel=ok', snap.items[0].stallLevel, 'ok');
}

/* ============ DONE_WINDOW_MS 常量一致 ============ */
console.log('\nDONE_WINDOW_MS');
{
  eq('2 小时', DONE_WINDOW_MS, 2 * 60 * 60 * 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
