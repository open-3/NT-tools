// 无 GUI 的采集自检：直接跑所有适配器，打印真实数据
import { CodexAdapter } from '../src/main/adapters/codex';
import { DshAdapter } from '../src/main/adapters/dsh';
import { WorkBuddyAdapter } from '../src/main/adapters/workbuddy';

const codex = new CodexAdapter();
const dsh = new DshAdapter();
const wb = new WorkBuddyAdapter();

function fmt(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  const s = Math.floor(d / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

for (const a of [codex, dsh, wb]) {
  console.log(`\n=== ${a.label} (detect=${a.detect()}) ===`);
  const t0 = Date.now();
  const rows = a.snapshot();
  const ms = Date.now() - t0;
  console.log(`items=${rows.length}  took=${ms}ms`);
  for (const r of rows) {
    const act = r.activity ? `${r.activity.label}${r.activity.detail ? ' · ' + r.activity.detail : ''}` : '';
    const pend = r.pending ? `pending=${r.pending.kind}:${r.pending.reason ?? ''}` : '';
    const sum = r.resultSummary ? `摘要="${r.resultSummary}"` : '';
    const ctx = r.context
      ? `ctx=${r.context.project}${r.context.branch ? '@' + r.context.branch : ''}`
      : '';
    const files = typeof r.changedFiles === 'number' ? `文件=${r.changedFiles}` : '';
    console.log(
      `  [${r.state}${r.confidence === 'inferred' ? '/inferred' : ''}] ${fmt(r.stateSince).padStart(4)}  ${r.title.slice(0, 24).padEnd(24)}  ${ctx}  ${files}  ${act}  ${pend}  ${sum}`,
    );
  }
}
