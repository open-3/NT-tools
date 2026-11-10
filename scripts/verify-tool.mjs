// 临时验证脚本：直接加载工具窗口，检查 JSON 工具页面能否正常渲染。
// 用法：node scripts/verify-tool.mjs <toolId> [port]
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');

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

  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[console]', msg));

  win.loadFile(path.join(root, 'dist', 'tools', toolId, 'index.html'));

  win.webContents.once('did-finish-load', async () => {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('[data-act=format]');
      const cm = document.querySelector('.cm-editor');
      const cmContent = document.querySelector('.cm-content');
      const gutter = document.querySelector('.cm-gutters');
      const hasToolApi = typeof window.tool === 'object' && typeof window.tool.openFile === 'function';
      // 注入初始内容：直接向 CodeMirror 编辑器粘贴
      cmContent.textContent = '{"a":1,"b":[2,3]}';
      document.querySelector('[data-act=format]').click();
      await new Promise(r => setTimeout(r, 100));
      return {
        title: document.title,
        hasBtn: !!btn,
        hasCM: !!cm,
        hasGutter: !!gutter,
        hasToolApi,
        editorText: cm.textContent.slice(0, 60),
        status: document.getElementById('status').textContent,
      };
    })()`);
    console.log('RESULT ' + JSON.stringify(result));
    app.quit();
  });

  setTimeout(() => {
    console.log('TIMEOUT');
    app.exit(2);
  }, 15000);
});

app.on('window-all-closed', () => app.quit());
