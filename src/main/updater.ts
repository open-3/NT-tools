import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

/**
 * 远程更新（electron-updater）。
 *
 * 前提：**打包目标必须是 NSIS installer，不是 portable**。
 * electron-updater 依赖固定安装路径做增量更新；portable 每次解压到临时目录，
 * 更新后重启就丢。所以本项目把发行形态从 portable 改成了 installer。
 *
 * 更新流程（胶囊徽章是唯一更新入口，不弹原生「发现新版本」对话框）：
 *   1. 启动后 + 每 1 小时周期检查，发现新版 → 浮窗显示「↑ 更新」胶囊
 *   2. 用户点胶囊 → 下载 → 胶囊实时显示「正在下载 x%」
 *   3. 下载完成 → 胶囊变「点击重启」→ 点击重启安装
 *   4. 托盘菜单的「检查更新」提供手动触发；无新版时弹「已是最新版本」
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
/** 已知可用的新版本号（发现新版时记录，供托盘菜单显示「有新版本」提示） */
let latestAvailableVersion: string | null = null;
/** 更新状态变化回调（发现新版/无新版时触发，main.ts 用它重建托盘菜单） */
let onStateChange: (() => void) | null = null;
/** 下载进度回调（下载百分比变化时触发，main.ts 用它更新托盘 tooltip） */
let onDownloadProgress: ((percent: number) => void) | null = null;
/** 是否正在下载（防重入：下载中再点「更新」不重复触发） */
let downloading = false;

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
 * 弹「发现新版本」对话框 —— 已移除。
 * 更新交互改为浮窗胶囊徽章（↑更新 / ↑正在下载 x% / 点击重启），
 * 胶囊是唯一更新入口，不再弹原生「发现新版本」对话框，避免重复打扰。
 */

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
    if (!result || !result.isUpdateAvailable) {
      latestAvailableVersion = null;
      send({ state: 'not-available', message: isManual ? '已是最新版本' : undefined });
      notifyStateChange();
      // 手动检查且无新版：弹一次「已是最新版本」明确反馈
      if (isManual) showNoUpdate();
      return;
    }

    // 发现新版：只记录 + 发 available 事件（胶囊显示「↑ 更新」），
    // 不自动下载、不弹框，等用户点胶囊才 downloadNow。
    const update = result.updateInfo;
    latestAvailableVersion = update.version;
    send({ state: 'available', version: update.version });
    notifyStateChange();
  } catch (e: any) {
    send({ state: 'error', message: e?.message ?? String(e) });
  }
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
    // 下载完成：发 downloaded 事件 → 胶囊显示「点击重启」；
    // 不再弹原生对话框。
    send({ state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (e: Error) => {
    send({ state: 'error', message: e.message });
  });

  // 启动后延迟几秒静默检查一次，然后每 1 小时周期检查一次。
  // 之前只查一次（setTimeout 一次性），应用常驻时不会自动发现新版本。
  // 用 setInterval 循环，首个间隔 8 秒后触发、之后每小时。
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
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
  if (downloading) return; // 已在下载，防重入
  downloading = true;
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
  } finally {
    downloading = false;
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
