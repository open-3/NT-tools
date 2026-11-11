/** 一次性跑完所有单测 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const suites = [
  { src: 'scripts/test-autocollapse.ts', out: 'dist/test-ac.cjs' },
  { src: 'scripts/test-adapters.ts', out: 'dist/test-ad.cjs' },
  { src: 'scripts/test-dsh-e2e.ts', out: 'dist/test-dsh.cjs' },
  { src: 'scripts/test-codex-e2e.ts', out: 'dist/test-codex.cjs' },
  { src: 'scripts/test-workbuddy-e2e.ts', out: 'dist/test-wb.cjs' },
  { src: 'scripts/test-devin-e2e.ts', out: 'dist/test-devin.cjs' },
  { src: 'scripts/test-summary.ts', out: 'dist/test-sum.cjs' },
  { src: 'scripts/test-project.ts', out: 'dist/test-proj.cjs' },
  { src: 'scripts/test-quota.ts', out: 'dist/test-quota.cjs' },
  { src: 'scripts/test-stall.ts', out: 'dist/test-stall.cjs' },
  { src: 'scripts/test-lan-e2e.ts', out: 'dist/test-lan.cjs' },
  { src: 'scripts/test-lan-transfer-e2e.ts', out: 'dist/test-lan-tx.cjs' },
  { src: 'scripts/test-lan-bigfile.ts', out: 'dist/test-lan-big.cjs' },
  { src: 'scripts/test-lan-dir.ts', out: 'dist/test-lan-dir.cjs' },
];

let failed = 0;
for (const s of suites) {
  execFileSync('npx', ['esbuild', s.src, '--bundle', '--platform=node', '--format=cjs', `--outfile=${s.out}`], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  try {
    execFileSync('node', [s.out], { cwd: root, stdio: 'inherit' });
  } catch {
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\nall suites passed');
