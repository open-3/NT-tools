import { ipcMain, BrowserWindow, dialog } from 'electron';
import { lanManager } from './lan';

/**
 * LAN 通信的 IPC 桥：把 lanManager 的能力暴露给渲染进程（window.lan）。
 *
 * 工具窗口是通用的 preload（src/tools/preload.ts），它已经暴露了 window.tool。
 * 这里额外暴露 window.lan，但 preload 是共享的、所有工具窗口都会加载 ——
 * 为避免给每个工具都挂 lan 能力，用「按需」策略：只在 lanchat 工具的窗口里
 * 通过 query 参数识别？不可行（preload 无 query 上下文）。
 *
 * 更简洁的方案：新增一个独立 preload（src/tools/preload-lan.ts），只给
 * lanchat 窗口用。这个文件负责：
 *   1. contextBridge 暴露 window.lan（invoke lan:*）
 *   2. 转发 lanManager 的事件到渲染层（lan:event）
 *
 * push 事件用 webContents.send，所以这里需要拿到 lanchat 窗口的引用。
 */

/** 已订阅的主进程 → 渲染层事件名 */
const EVENTS = ['snapshot', 'message', 'transfer-progress', 'incoming-offer'] as const;

let lanWindow: BrowserWindow | null = null;

/** 记录 lanchat 窗口（openTool 打开时调用） */
export function setLanWindow(win: BrowserWindow | null): void {
  lanWindow = win;
}

function push(channel: string, payload: unknown): void {
  if (lanWindow && !lanWindow.isDestroyed()) {
    lanWindow.webContents.send(`lan:event`, { channel, payload });
  }
}

/** 订阅 lanManager 事件并转发到渲染层 */
function wireEvents(): void {
  for (const name of EVENTS) {
    lanManager.on(name as any, (payload: unknown) => {
      push(name, payload);
    });
  }
}

export function installLanIpc(): void {
  // 只 wire 一次
  if ((lanManager as any).__wired) return;
  (lanManager as any).__wired = true;
  wireEvents();

  ipcMain.handle('lan:start', () => {
    lanManager.start();
    return lanManager.getSnapshot();
  });

  ipcMain.handle('lan:stop', () => {
    lanManager.stop();
    return true;
  });

  ipcMain.handle('lan:snapshot', () => lanManager.getSnapshot());

  ipcMain.handle('lan:sendChat', (_e, peerId: string, text: string) => {
    return lanManager.sendChat(peerId, text);
  });

  ipcMain.handle('lan:broadcast', (_e, text: string) => {
    return lanManager.broadcast(text);
  });

  ipcMain.handle('lan:sendFile', async (_e, peerId: string, filePath: string) => {
    return lanManager.sendFile(peerId, filePath);
  });

  ipcMain.handle('lan:acceptFile', (_e, transferId: number, ok: boolean, savePath?: string) => {
    lanManager.acceptFile(transferId, ok, savePath);
    return true;
  });

  ipcMain.handle('lan:messages', (_e, peerId: string, limit?: number) => {
    return lanManager.getMessages(peerId, limit ?? 200);
  });

  ipcMain.handle('lan:pickFile', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('lan:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
}
