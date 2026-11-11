import { build } from 'esbuild';
import * as path from 'node:path';

const root = process.cwd();

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // electron-updater 有内部动态 require（js-yaml、electron、fs-extra 等），
  // bundle 进来会破坏其运行时解析，所以和 electron 一样保持 external，
  // 由 electron-builder 打进 asar 后走 node_modules 正常 require。
  external: ['electron', 'electron-updater'],
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/main/main.ts', 'src/preload/preload.ts'],
  outdir: 'dist/main',
  outExtension: { '.js': '.js' },
  entryNames: '[name]',
});

// 工具窗口的 preload 单独放到 dist/tools/preload.js
await build({
  ...common,
  entryPoints: ['src/tools/preload.ts'],
  outfile: 'dist/tools/preload.js',
});

// lanchat 工具窗口的专属 preload（window.lan）
await build({
  ...common,
  entryPoints: ['src/tools/preload-lan.ts'],
  outfile: 'dist/tools/preload-lan.js',
});
