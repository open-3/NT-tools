import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();

/* ---- 主浮窗渲染层 ---- */
const rendererOut = path.join(root, 'dist', 'renderer');
fs.mkdirSync(rendererOut, { recursive: true });

await build({
  entryPoints: ['src/renderer/index.ts'],
  outfile: path.join(rendererOut, 'renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
});

fs.copyFileSync(path.join(root, 'src', 'renderer', 'index.html'), path.join(rendererOut, 'index.html'));
fs.copyFileSync(path.join(root, 'src', 'renderer', 'style.css'), path.join(rendererOut, 'style.css'));

/* ---- 工具箱里的各个小工具 ---- */
const toolsDir = path.join(root, 'src', 'tools');
const toolsOut = path.join(root, 'dist', 'tools');
fs.mkdirSync(toolsOut, { recursive: true });

let toolIds = [];
try {
  toolIds = fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(toolsDir, e.name, 'index.ts')))
    .map((e) => e.name);
} catch {
  toolIds = [];
}

/**
 * 某些工具需要运行时的额外资源（不进 esbuild bundle，靠 file:// 直接加载）。
 *
 * 用 `src/tools/<id>/runtime.json` 声明：
 *   {
 *     "copy": [
 *       { "from": "node_modules/tesseract.js/dist", "include": ["worker.min.js"] },
 *       { "from": "node_modules/tesseract.js-core", "include": ["*.wasm"] }
 *     ]
 *   }
 *
 * 目的：让「加新工具」仍然不需要改构建脚本 —— 工具自己声明依赖哪此资源。
 */
function copyRuntimeDeps(srcDir, outDir) {
  const manifest = path.join(srcDir, 'runtime.json');
  if (!fs.existsSync(manifest)) return 0;

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    console.warn(`[build] runtime.json 解析失败: ${manifest} — ${e.message}`);
    return 0;
  }

  let n = 0;
  for (const entry of spec.copy ?? []) {
    const fromDir = path.resolve(root, entry.from);
    if (!fs.existsSync(fromDir)) {
      console.warn(`[build] 运行时依赖不存在，跳过: ${entry.from}`);
      continue;
    }
    const target = entry.to ? path.join(outDir, entry.to) : outDir;

    // recursive: true 时整目录树拷贝（如 Monaco 的 vs/ 目录，含大量子目录）
    if (entry.recursive) {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(fromDir, target, { recursive: true });
      n += countFiles(fromDir);
      continue;
    }

    const include = entry.include ?? ['*'];
    // include 支持简单通配：完全匹配 或 *.ext
    const match = (name) =>
      include.some((pat) => (pat.startsWith('*.') ? name.endsWith(pat.slice(1)) : pat === name));

    fs.mkdirSync(target, { recursive: true });

    for (const f of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (!f.isFile() || !match(f.name)) continue;
      fs.copyFileSync(path.join(fromDir, f.name), path.join(target, f.name));
      n++;
    }
  }
  return n;
}

function countFiles(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) n += countFiles(path.join(dir, f.name));
    else n++;
  }
  return n;
}

for (const id of toolIds) {
  const srcDir = path.join(toolsDir, id);
  const outDir = path.join(toolsOut, id);
  // 每次清空工具输出目录：避免删掉源文件后 dist 里残留旧产物
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    minify: false,
    sourcemap: true,
    logLevel: 'info',
  });

  // 复制静态资源（index.html / style.css / lang 语言包 等）
  for (const f of fs.readdirSync(srcDir, { withFileTypes: true })) {
    // 排除入口、所有 TS 源码、sourcemap、以及运行时清单本身
    if (f.name === 'index.ts' || f.name.endsWith('.ts') || f.name.endsWith('.map')) continue;
    if (f.name === 'runtime.json') continue;
    const from = path.join(srcDir, f.name);
    const to = path.join(outDir, f.name);
    if (f.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }

  const deps = copyRuntimeDeps(srcDir, outDir);
  if (deps) console.log(`[build] ${id}: +${deps} runtime files`);
}

/* ---- 工具窗口图标：程序化生成的圆角方块，拷到 dist/icons 随 asar 打包 ---- */
const iconsSrc = path.join(root, 'build', 'icons');
const iconsOut = path.join(root, 'dist', 'icons');
if (fs.existsSync(iconsSrc)) {
  fs.rmSync(iconsOut, { recursive: true, force: true });
  fs.mkdirSync(iconsOut, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(iconsSrc)) {
    if (!f.endsWith('.ico')) continue;
    fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsOut, f));
    n++;
  }
  console.log(`[build] icons ok (+${n} ico)`);
} else {
  console.warn('[build] build/icons 不存在，跳过工具图标拷贝');
}

console.log(`[build] renderer ok (+${toolIds.length} tools: ${toolIds.join(', ') || 'none'})`);
