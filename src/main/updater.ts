import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

/**
 * 远程更新（electron-updater）。
 *
 * 前提：**打包目标必须是 NSIS installer，不是 portable**。
 * electron-updater 依赖固定安装路径做增量更新；portable 每次解压到临时目录，
 * 更新后重启就丢。所以本项目把发行形态从 portable 改成了 installer。
 *
 * 更新流程：
 *   1. 启动时静默 checkForUpdates，发现新版 → 弹对话框问用户是否更新
 *   2. 用户确认 → 下载 → 校验 → 提示重启安装
 *   3. 托盘菜单提供「检查更新」手动入口
 *
 * 更新元数据从 package.json 的 build.publish（GitHub Releases open-3/NT-tools）读取。
 * 开发者用 electron-builder --publish 发布时，会生成 latest.yml 供客户端比对。
 */

interface UpdateEventPayload {
  state: 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  message?: string;
}

let win: BrowserWindow | null = null;
let manualPrompting = false;
let autoPromptShown = false;

function send(payload: UpdateEventPayload): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pulse:update-event', payload);
  }
}

/** 人性化的速度显示 */
function humanSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSecond} B/s`;
}

/**
 * 弹「发现新版本」对话框，返回用户是否要现在更新。
 * 启动时的静默检查只弹一次；手动检查每次都弹。
 */
async function promptUpdate(info: UpdateInfo): Promise<boolean> {
  if (!win) return false;
  win.show();
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 ${info.version}`,
    detail: `当前版本 ${app.getVersion()}\n\n是否立即下载更新？`,
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

async function doCheckAndUpdate(isManual: boolean): Promise<void> {
  // 开发态（未打包）没有有效的更新通道，直接提示不可用
  if (!app.isPackaged) {
    send({ state: 'not-available', message: '开发模式下不检查更新' });
    return;
  }

  try {
    send(isManual ? { state: 'not-available', message: '检查中…' } : { state: 'not-available' });
    const info = await autoUpdater.checkForUpdates();

    if (!info) {
      send({ state: 'not-available', message: isManual ? '已是最新版本' : undefined });
      return;
    }

    // info.updateInfo 是 UpdateInfo；downloaded 时已就绪
    const update = info.updateInfo;
    send({ state: 'available', version: update.version });

    // 手动检查直接弹框；自动检查只在首次弹
    const shouldPrompt = isManual ? true : !autoPromptShown;
    if (shouldPrompt && !manualPrompting) {
      manualPrompting = true;
      autoPromptShown = true;
      const ok = await promptUpdate(update);
      manualPrompting = false;
      if (!ok) return; // 用户选「稍后」
    }

    await autoUpdater.downloadUpdate();
    // 下载完成后 downloadUpdate 会 resolve；真实安装由 quitAndInstall 触发
    send({ state: 'downloaded', version: update.version });
    promptInstall(update.version);
  } catch (e: any) {
    send({ state: 'error', message: e?.message ?? String(e) });
  }
}

function promptInstall(version: string): void {
  if (!win) return;
  win.show();
  dialog
    .showMessageBox(win, {
      type: 'info',
      title: '更新已下载',
      message: `新版本 ${version} 已下载完成`,
      detail: '重启应用即可完成安装。现在重启吗？',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
}

/** 初始化：注册进度事件 + 启动时静默检查 */
export function initUpdater(target: BrowserWindow): void {
  win = target;

  autoUpdater.autoDownload = false; // 先问用户，不自动下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动装（若已下载）

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    send({
      state: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    send({ state: 'downloaded', version: info.version });
    promptInstall(info.version);
  });

  autoUpdater.on('error', (e: Error) => {
    send({ state: 'error', message: e.message });
  });

  // 启动后延迟几秒静默检查，避免和启动抢资源
  setTimeout(() => {
    void doCheckAndUpdate(false);
  }, 8000);
}

/** 手动检查更新（托盘菜单入口） */
export function checkForUpdates(): void {
  void doCheckAndUpdate(true);
}

/** 下载进度查询（renderer 问进度时回复最新事件） */
export function installUpdaterIpc(): void {
  ipcMain.handle('pulse:check-update', () => {
    checkForUpdates();
    return true;
  });
}
