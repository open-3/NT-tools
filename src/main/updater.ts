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
/** 已知可用的新版本号（发现新版时记录，供托盘菜单显示「有新版本」提示） */
let latestAvailableVersion: string | null = null;
/** 更新状态变化回调（发现新版/无新版时触发，main.ts 用它重建托盘菜单） */
let onStateChange: (() => void) | null = null;
/** 下载进度回调（下载百分比变化时触发，main.ts 用它更新托盘 tooltip） */
let onDownloadProgress: ((percent: number) => void) | null = null;

function notifyStateChange(): void {
  if (onStateChange) onStateChange();
}

function send(payload: UpdateEventPayload): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pulse:update-event', payload);
  }
}

/** 供 main.ts 查询：当前是否有已知的新版本（用于托盘菜单动态显示） */
export function getAvailableVersion(): string | null {
  return latestAvailableVersion;
}

/** 供 main.ts 注册：更新状态变化时重建托盘菜单 */
export function setUpdaterStateListener(cb: () => void): void {
  onStateChange = cb;
}

/** 供 main.ts 注册：下载进度变化时更新托盘 tooltip */
export function setUpdaterProgressListener(cb: (percent: number) => void): void {
  onDownloadProgress = cb;
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
    const result = await autoUpdater.checkForUpdates();

    // 关键：checkForUpdates 永远返回非 null 对象，是否真的有更新
    // 要看 result.isUpdateAvailable 字段；返回 null 只在 updater 被禁用时出现。
    // 之前误判成「返回 null = 无更新」，导致同版本也被当成有更新。
    if (!result || !result.isUpdateAvailable) {
      latestAvailableVersion = null;
      send({ state: 'not-available', message: isManual ? '已是最新版本' : undefined });
      notifyStateChange();
      // 手动检查且无新版：弹原生对话框给个明确反馈（否则点了没反应）
      if (isManual) showNoUpdate();
      return;
    }

    const update = result.updateInfo;
    latestAvailableVersion = update.version;
    send({ state: 'available', version: update.version });
    notifyStateChange();

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
    // 下载完成会触发 'update-downloaded' 事件，在那里提示重启安装；
    // 这里不再手动弹框，避免和事件重复弹两次。
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

/** 手动检查时无新版：弹一次明确的「已是最新版本」提示，避免点击无反馈 */
function showNoUpdate(): void {
  if (!win) return;
  win.show();
  void dialog.showMessageBox(win, {
    type: 'info',
    title: '检查更新',
    message: '已是最新版本',
    detail: `当前版本 ${app.getVersion()} 已是最新，无需更新。`,
    buttons: ['好的'],
    defaultId: 0,
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
    if (onDownloadProgress) onDownloadProgress(p.percent);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    send({ state: 'downloaded', version: info.version });
    promptInstall(info.version);
  });

  autoUpdater.on('error', (e: Error) => {
    send({ state: 'error', message: e.message });
  });

  // 启动后延迟几秒静默检查一次，然后每 1 小时周期检查一次。
  // 之前只查一次（setTimeout 一次性），应用常驻时不会自动发现新版本。
  // 用 setInterval 循环，首个间隔 8 秒后触发、之后每小时。
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 小时
  setTimeout(() => {
    void doCheckAndUpdate(false);
    setInterval(() => {
      void doCheckAndUpdate(false);
    }, CHECK_INTERVAL_MS);
  }, 8000);
}

/** 手动检查更新（托盘菜单入口） */
export function checkForUpdates(): void {
  void doCheckAndUpdate(true);
}

/** 胶囊「↑ 更新」按钮：直接下载已知的新版本，不再弹确认框 */
export async function downloadNow(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    // 确保有过一次检查，拿到 updateInfoAndProvider
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
      send({ state: 'not-available', message: '已是最新版本' });
      return;
    }
    latestAvailableVersion = result.updateInfo.version;
    notifyStateChange();
    // 直接下载，下载进度事件会驱动胶囊显示百分比
    await autoUpdater.downloadUpdate();
  } catch (e: any) {
    send({ state: 'error', message: e?.message ?? String(e) });
  }
}

/** 胶囊「点击重启」按钮：立即重启并安装已下载的更新 */
export function restartNow(): void {
  autoUpdater.quitAndInstall(false, true);
}

/** 下载进度查询（renderer 问进度时回复最新事件） */
export function installUpdaterIpc(): void {
  ipcMain.handle('pulse:check-update', () => {
    checkForUpdates();
    return true;
  });

  // 胶囊「↑ 更新」按钮 → 直接下载
  ipcMain.on('pulse:update-now', () => {
    void downloadNow();
  });

  // 胶囊「点击重启」按钮 → 重启安装
  ipcMain.on('pulse:update-restart', () => {
    restartNow();
  });
}
