/**
 * 启动器：规避 ELECTRON_RUN_AS_NODE 环境变量，并支持隔离的 HOME 目录做空态测试。
 *
 * 用法：
 *   node scripts/launch.mjs                 正常启动
 *   node scripts/launch.mjs --empty-home    用临时空目录冒充 USERPROFILE（验证空态）
 *   node scripts/launch.mjs -- --remote-debugging-port=9444   透传参数给 electron
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep >= 0 ? argv.slice(0, sep) : argv;
const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (flags.includes('--empty-home')) {
  const fake = path.join(appDir, '_emptyhome');
  fs.mkdirSync(path.join(fake, 'AppData', 'Roaming'), { recursive: true });
  env.USERPROFILE = fake;
  env.APPDATA = path.join(fake, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(fake, 'AppData', 'Local');
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  console.log('[launch] isolated USERPROFILE =', fake);
}

const child = spawn(electron, ['.', ...passthrough], {
  cwd: appDir,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
