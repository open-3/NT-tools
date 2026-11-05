// 临时验证脚本：直接加载工具窗口，检查 JSON 工具页面能否正常渲染。
// 用法：node scripts/verify-tool.mjs <toolId> [port]
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const toolId = process.argv[2] || 'jsonfmt';
const port = Number(process.argv[3] || 9931);

// 清掉会破坏 electron 的环境变量
delete process.env.ELECTRON_RUN_AS_NODE;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 760,
    height: 580,
    show: true,
    webPreferences: {
      preload: path.join(root, 'dist', 'tools', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 验证工具窗口的 preload 是否注入成功 + 页面渲染
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[console]', msg));

  win.loadFile(path.join(root, 'dist', 'tools', toolId, 'index.html'));

  win.webContents.once('did-finish-load', async () => {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('[data-act=format]');
      const ta = document.querySelector('.jb-text');
      const hasToolApi = typeof window.tool === 'object' && typeof window.tool.openFile === 'function';
      // 模拟粘贴 + 格式化
      ta.value = '{"a":1,"b":[2,3]}';
      document.querySelector('[data-act=format]').click();
      await new Promise(r => setTimeout(r, 50));
      return {
        title: document.title,
        hasBtn: !!btn,
        hasTextarea: !!ta,
        hasToolApi,
        formatted: ta.value,
        status: document.getElementById('status').textContent,
      };
    })()`);
    console.log('RESULT ' + JSON.stringify(result));
    // 测错误路径
    const err = await win.webContents.executeJavaScript(`(async () => {
      const ta = document.querySelector('.jb-text');
      ta.value = '{bad json';
      document.querySelector('[data-act=format]').click();
      await new Promise(r => setTimeout(r, 50));
      return { status: document.getElementById('status').textContent };
    })()`);
    console.log('ERROR-CASE ' + JSON.stringify(err));
    app.quit();
  });

  // 超时保护
  setTimeout(() => {
    console.log('TIMEOUT');
    app.exit(2);
  }, 15000);
});

app.on('window-all-closed', () => app.quit());
