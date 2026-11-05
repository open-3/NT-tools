import { BrowserWindow, Menu, dialog, ipcMain, screen, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 工具箱：给浮窗外挂一组独立的小工具窗口。
 *
 * 设计约束：
 *  1. 每个工具是一个独立的 BrowserWindow，可多开（每次点菜单开一个新窗口）。
 *  2. 工具代码放 `src/tools/<id>/`，构建后输出到 `dist/tools/<id>/`，
 *     与主浮窗的 `dist/renderer` 完全隔离，互不影响。
 *  3. 新增工具只需在 TOOLS 数组加一行 + 建一个目录，无需改主浮窗逻辑。
 *  4. 文件打开/保存/另存走原生对话框（renderer 用 JSON.parse 做格式化，
 *     不经过主进程，也不引入任何依赖）。
 */

export interface ToolDef {
  /** 目录名，也是 `dist/tools/<id>` 的路径段 */
  id: string;
  /** 菜单里显示的名字 */
  label: string;
  /** 菜单里的图标字（用字符代替图标，避免依赖图标字体） */
  icon: string;
  /**
   * 该工具是否需要在页面里嵌外部网页（<webview>）。
   * 需要时开窗必须启用 webviewTag —— 因为是页面级开关，不能按工具单独开，
   * 所以整组工具窗口统一带上；只有真的用了 webview 的工具才有实际作用。
   */
  webview?: boolean;
}

/** 工具注册表 —— 以后加小工具就在这加一行。 */
export const TOOLS: ToolDef[] = [
  { id: 'jsonfmt', label: 'JSON 格式化', icon: '{ }' },
  { id: 'translate', label: '翻译', icon: '译', webview: true },
  { id: 'ocr', label: '图片取字', icon: '文' },
];

/** 每个工具当前打开的窗口列表（按 id 分组，窗口关闭时移除） */
const toolWindows = new Map<string, BrowserWindow[]>();

function toolEntry(toolId: string): string {
  // __dirname 是 dist/main，工具页面在 dist/tools/<id>/
  return path.join(__dirname, '..', 'tools', toolId, 'index.html');
}

function toolPreload(): string {
  return path.join(__dirname, '..', 'tools', 'preload.js');
}

export function openTool(toolId: string): void {
  const def = TOOLS.find((t) => t.id === toolId);
  if (!def) return;

  // 目标尺寸：760×580 → 1140×1160（宽 1.5 倍、高 2 倍）。
  // 但 1160 在 1080p 笔记本上会超出可用高度，所以按当前屏幕再收一下，
  // 同时居中，避免窗口跑到屏幕外。
  const targetW = 1140;
  const targetH = 1160;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(targetW, Math.round(area.width * 0.92));
  const height = Math.min(targetH, Math.round(area.height * 0.92));
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 420,
    minHeight: 300,
    title: def.label,
    autoHideMenuBar: true,
    // 与工具页 (#ffffff) 一致，避免打开时闪一下深色
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: toolPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 「翻译」这类工具要嵌外部页面，必须开 webviewTag。
      // 这是 BrowserWindow 级开关，无法按工具细分，所以统一开；
      // 不用 webview 的工具（如 JSON 格式化）不受任何影响。
      webviewTag: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(toolEntry(toolId));

  /*
   * 工具窗口里所有「开新窗口」的请求都交给系统浏览器。
   * 典型场景：翻译工具里点网页内的外链 / window.open。
   * 不在应用内开新 BrowserWindow —— 那会得到一堆无边框、无菜单、关不掉的裸窗口。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 内嵌 webview 里的 window.open 也要走同一套策略
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  const list = toolWindows.get(toolId) ?? [];
  list.push(win);
  toolWindows.set(toolId, list);

  win.on('closed', () => {
    const arr = toolWindows.get(toolId);
    if (!arr) return;
    const i = arr.indexOf(win);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) toolWindows.delete(toolId);
  });
}

/** 弹出工具箱菜单（挂到浮窗的工具箱按钮上） */
export function showToolboxMenu(parent: BrowserWindow | null): void {
  const template: Electron.MenuItemConstructorOptions[] = TOOLS.map((t) => ({
    label: `${t.icon}  ${t.label}`,
    click: () => openTool(t.id),
  }));

  template.push({ type: 'separator' });
  template.push({ label: '更多小工具待扩展…', enabled: false });

  const menu = Menu.buildFromTemplate(template);
  if (parent) menu.popup({ window: parent });
  else menu.popup();
}

/* ------------------------------------------------------------------ */
/* 工具窗口的文件 IPC（打开 / 保存 / 另存）                              */
/* ------------------------------------------------------------------ */

interface OpenResult {
  path: string;
  content: string | null;
  error?: string;
}

interface SaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const FILE_FILTERS = [
  { name: 'JSON / 文本', extensions: ['json', 'txt', 'jsonl'] },
  { name: '所有文件', extensions: ['*'] },
];

export function installToolIpc(): void {
  ipcMain.handle('tool:openFile', async (): Promise<OpenResult | null> => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: FILE_FILTERS,
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    try {
      return { path: p, content: fs.readFileSync(p, 'utf8') };
    } catch (e: any) {
      return { path: p, content: null, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('tool:saveFile', async (_e, filePath: string, content: string): Promise<SaveResult> => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '没有文件路径' };
    try {
      fs.writeFileSync(filePath, String(content), 'utf8');
      return { ok: true, path: filePath };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle(
    'tool:saveFileAs',
    async (_e, defaultName: string, content: string): Promise<SaveResult | null> => {
      const r = await dialog.showSaveDialog({
        defaultPath: defaultName || 'untitled.json',
        filters: FILE_FILTERS,
      });
      if (r.canceled || !r.filePath) return null;
      try {
        fs.writeFileSync(r.filePath, String(content), 'utf8');
        return { ok: true, path: r.filePath };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );
}
