// 临时验证脚本：加载 JSON 工具窗口，验证 Monaco 是否正常渲染。
// 用法：electron scripts/verify-monaco.cjs [toolId]
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const toolId = process.argv[2] || 'jsonfmt';

delete process.env.ELECTRON_RUN_AS_NODE;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    show: true,
    webPreferences: {
      preload: path.join(root, 'dist', 'tools', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    console.log(`[console:${level}] ${msg}`);
  });

  win.loadFile(path.join(root, 'dist', 'tools', toolId, 'index.html'));

  win.webContents.once('did-finish-load', async () => {
    // 等 Monaco AMD 加载完成 + 编辑器实例化
    await new Promise((r) => setTimeout(r, 4000));

    const result = await win.webContents.executeJavaScript(`(async () => {
      const host = document.getElementById('monaco-host');
      const btn = document.querySelector('[data-act=format]');
      const hasMonaco = typeof window.monaco === 'object' && !!window.monaco.editor;
      const cmRoot = document.querySelector('.monaco-editor');
      const margin = document.querySelector('.monaco-editor .margin');
      const status = document.getElementById('status') ? document.getElementById('status').textContent : null;

      // 通过全局 monaco API 拿编辑器内容写入测试
      let setResult = null;
      let fmtResult = null;
      try {
        const models = window.monaco.editor.getModels();
        if (models.length > 0) {
          models[0].setValue('{"a":1,"b":[2,3]}');
          document.querySelector('[data-act=format]').click();
          await new Promise(r => setTimeout(r, 300));
          fmtResult = models[0].getValue();
        }
      } catch (e) {
        setResult = String(e);
      }

      return {
        hasMonaco,
        hasHost: !!host,
        hasBtn: !!btn,
        hasCMRoot: !!cmRoot,
        hasMargin: !!margin,
        statusAfterLoad: status,
        setError: setResult,
        formatted: fmtResult,
        modelCount: window.monaco && window.monaco.editor ? window.monaco.editor.getModels().length : -1,
      };
    })()`);

    console.log('RESULT ' + JSON.stringify(result, null, 2));
    app.quit();
  });

  setTimeout(() => {
    console.log('TIMEOUT');
    app.exit(2);
  }, 20000);
});

app.on('window-all-closed', () => app.quit());
