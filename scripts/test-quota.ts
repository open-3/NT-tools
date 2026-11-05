// 额度读写的单测：只测 readQuota（从 rollout 尾部读 rate_limits）。
// 这是「已删掉的 token 统计」里留下的、仍然有价值的部分 ——
// 额度百分比是 OpenAI 服务端下发的，权威，不能删。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readQuota } from '../src/main/quota';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-quota-'));
const dir = path.join(tmp, 'sessions', '2026', '11', '04');
fs.mkdirSync(dir, { recursive: true });

const saved = process.env.AGENT_PULSE_CODEX_HOME;
process.env.AGENT_PULSE_CODEX_HOME = tmp;

const rl = {
  limit_id: 'codex',
  primary: { used_percent: 82, window_minutes: 300, resets_at: 1793761188 },
  secondary: { used_percent: 63, window_minutes: 10080, resets_at: 1793776247 },
  plan_type: 'plus',
};
const line = JSON.stringify({
  timestamp: new Date().toISOString(),
  type: 'event_msg',
  payload: { type: 'token_count', info: {}, rate_limits: rl },
});

console.log('\nreadQuota');
{
  // 小文件 → 直接全量读
  fs.writeFileSync(path.join(dir, 'rollout-q.jsonl'), line + '\n');
  const q = readQuota();
  ok('读到配额', !!q);
  eq('primary 百分比', q?.primary.usedPct, 82);
  eq('primary 窗口分钟', q?.primary.windowMin, 300);
  eq('secondary 百分比', q?.secondary?.usedPct, 63);
  eq('plan', q?.plan, 'plus');
  ok('sampledAt 有值', (q?.sampledAt ?? 0) > 0);

  // 大文件 → 尾部读（只读最后 32KB）
  const filler = JSON.stringify({ timestamp: new Date().toISOString(), type: 'x', pad: 'z'.repeat(200) });
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) lines.push(filler);
  lines.push(line); // 最新一条在最后
  const big = path.join(dir, 'rollout-big.jsonl');
  fs.writeFileSync(big, lines.join('\n') + '\n');
  ok('大文件 > 32KB', fs.statSync(big).size > 32 * 1024);
  const q2 = readQuota();
  ok('尾部读也能拿到配额', !!q2);
  eq('大文件 readQuota 百分比', q2?.primary.usedPct, 82);
}
{
  // 单独一个干净的 codex HOME，没有任何 rate_limits → undefined，不瞎猜
  // （readQuota 扫的是整个 sessions 目录，不能和上面带 rate_limits 的文件混在一起测）
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-qempty-'));
  const edir = path.join(empty, 'sessions', '2026', '11', '05');
  fs.mkdirSync(edir, { recursive: true });
  fs.writeFileSync(
    path.join(edir, 'rollout-n.jsonl'),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'x' }) + '\n',
  );
  const savedCodex = process.env.AGENT_PULSE_CODEX_HOME;
  process.env.AGENT_PULSE_CODEX_HOME = empty;
  const q = readQuota();
  eq('没有 rate_limits → undefined', q, undefined);
  process.env.AGENT_PULSE_CODEX_HOME = savedCodex;
  fs.rmSync(empty, { recursive: true, force: true });
}

process.env.AGENT_PULSE_CODEX_HOME = saved;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
