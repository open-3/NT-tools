// 验证工具窗口独立图标加载无误（跑 release/win-unpacked 目录下）
// 用法: electron verify-icon.cjs <toolId>
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');

// 脚本位于 app/scripts/，win-unpacked 位于 app/release/win-unpacked/
const unpacked = path.join(__dirname, '..', 'release', 'win-unpacked');
const toolId = process.argv[process.argv.length - 1] || 'jsonfmt';
const iconPath = path.join(unpacked, 'resources', 'app.asar', 'dist', 'icons', toolId + '.png');
const pagePath = path.join(unpacked, 'resources', 'app.asar', 'dist', 'tools', toolId, 'index.html');

app.whenReady().then(async () => {
  let img = nativeImage.createFromPath(iconPath);
  console.log('ICON_EMPTY=' + img.isEmpty() + ' SIZE=' + JSON.stringify(img.getSize()));

  let win;
  try {
    win = new BrowserWindow({ width: 800, height: 600, show: false, icon: iconPath });
    await win.loadFile(pagePath);
    const title = win.getTitle();
    console.log('LOAD_OK=' + toolId + ' TITLE=' + title);
  } catch (e) {
    console.log('LOAD_ERR=' + (e && e.message));
  } finally {
    if (win) win.destroy();
    app.quit();
  }
});
