import { BrowserWindow, Menu, dialog, ipcMain, screen, shell, desktopCapturer } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

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
  /**
   * 窗口尺寸（宽×高）。省略时用默认大窗（JSON 格式化等长内容工具）。
   * 小工具（时间戳、正则、颜色…）用紧凑尺寸，避免开出一大片空白。
   */
  size?: { width: number; height: number };
}

/** 工具注册表 —— 以后加小工具就在这加一行。 */
export const TOOLS: ToolDef[] = [
  { id: 'jsonfmt', label: 'JSON 格式化', icon: '{ }' },
  { id: 'translate', label: '翻译', icon: '译', webview: true },
  { id: 'ocr', label: '图片取字', icon: '文' },
  // 第一档：开发者小工具
  { id: 'timestamp', label: '时间戳换算', icon: '⏱', size: { width: 560, height: 640 } },
  { id: 'codec', label: '编码转换', icon: '⇄', size: { width: 620, height: 680 } },
  { id: 'regex', label: '正则测试', icon: '.*', size: { width: 760, height: 720 } },
  { id: 'generate', label: '随机生成', icon: '⚄', size: { width: 560, height: 680 } },
  { id: 'color', label: '颜色转换', icon: '●', size: { width: 540, height: 620 } },
  { id: 'jwt', label: 'JWT 解析', icon: '🔑', size: { width: 720, height: 720 } },
  // 第二档：复用 OCR/文件/剪贴板
  { id: 'screentranslate', label: '截图翻译', icon: '📸', size: { width: 720, height: 760 } },
  { id: 'imgcompress', label: '图片压缩', icon: '🗜', size: { width: 640, height: 700 } },
  { id: 'qrcode', label: '二维码', icon: '▣', size: { width: 620, height: 680 } },
  { id: 'table', label: '表格查看', icon: '⊞', size: { width: 860, height: 760 } },
  // 第三档：复用本地数据聚合
  { id: 'diskusage', label: '磁盘占用', icon: '◔', size: { width: 640, height: 740 } },
  { id: 'netstat', label: '端口进程', icon: '⬡', size: { width: 720, height: 720 } },
  { id: 'clipboard', label: '剪贴板历史', icon: '📋', size: { width: 560, height: 680 } },
  { id: 'env', label: '环境变量', icon: '🎛', size: { width: 700, height: 740 } },
  // 其他小工具
  { id: 'cheatsheet', label: '终端小抄', icon: '⌘', size: { width: 740, height: 760 } },
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

/** 工具窗口独立图标（程序化生成的彩色圆角方块，见 scripts/gen-tool-icons.py） */
function toolIconPath(id: string): string {
  // 构建时 build/icons/*.ico 拷到 dist/icons/，随 asar 打包；Electron 可透明读 asar 内路径。
  // 用 ICO（含 16~256 多尺寸）而非 PNG：Windows 下 ICO 对标题栏/任务栏效果最佳（官方推荐）。
  return path.join(__dirname, '..', 'icons', `${id}.ico`);
}

export function openTool(toolId: string): void {
  const def = TOOLS.find((t) => t.id === toolId);
  if (!def) return;

  // 目标尺寸：优先用工具自带的 size（小工具紧凑），否则默认大窗。
  // 大窗 1140×1160 是给 JSON 格式化这类长内容工具调的；
  // 1160 在 1080p 笔记本上会超出可用高度，所以按当前屏幕再收一下，同时居中。
  const targetW = def.size?.width ?? 1140;
  const targetH = def.size?.height ?? 1160;
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
    icon: toolIconPath(def.id),
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
  ipcMain.handle('tool:openFile', async (_e, defaultPath?: string): Promise<OpenResult | null> => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: FILE_FILTERS,
    };
    if (typeof defaultPath === 'string' && defaultPath) {
      opts.defaultPath = defaultPath;
    }
    const r = await dialog.showOpenDialog(opts);
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

  /* ---------- 二进制文件读取（图片压缩等） ---------- */

  ipcMain.handle('tool:readBinaryFile', async (): Promise<any> => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    try {
      const buf = fs.readFileSync(p);
      return { path: p, data: new Uint8Array(buf), name: path.basename(p) };
    } catch (e: any) {
      return { path: p, data: null, error: e?.message ?? String(e) };
    }
  });

  /* ---------- 目录只读扫描（磁盘占用分析） ---------- */

  ipcMain.handle('tool:scanDir', async (_e, dirPath?: string): Promise<any> => {
    let target = typeof dirPath === 'string' && dirPath ? dirPath : null;
    if (!target) {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return null;
      target = r.filePaths[0];
    }
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
        let size = 0;
        if (d.isFile()) {
          try {
            size = fs.statSync(path.join(target!, d.name)).size;
          } catch {
            size = 0;
          }
        }
        return { name: d.name, path: path.join(target!, d.name), isDir: d.isDirectory(), size };
      });
      return { path: target, items: entries };
    } catch (e: any) {
      return { path: target, items: [], error: e?.message ?? String(e) };
    }
  });

  /* ---------- 受限系统命令（端口/进程查看） ---------- */

  // 白名单：只允许这些无副作用的命令，参数也受限
  const CMD_WHITELIST: Record<string, string[]> = {
    // 端口/进程：netstat 无法用 execFile 直接跑（是系统命令），用 poweshell 兜底
    netstat: ['-ano'],
  };
  const PS_WHITELIST: Record<string, string> = {
    ports: 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort',
    processes: 'Get-Process | Select-Object Id,ProcessName,@{n="MB";e={[math]::Round($_.WorkingSet64/1MB,1)}} | Sort-Object MB -Descending | Select-Object -First 100',
  };

  ipcMain.handle('tool:runCmd', async (_e, key: string, _args?: string[]): Promise<any> => {
    if (PS_WHITELIST[key]) {
      return await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', PS_WHITELIST[key]],
          { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) resolve({ stdout, stderr, code: err.code ?? 1, error: err.message });
            else resolve({ stdout, stderr, code: 0 });
          },
        );
      });
    }
    if (CMD_WHITELIST[key]) {
      return await new Promise((resolve) => {
        execFile(key, CMD_WHITELIST[key], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) resolve({ stdout, stderr, code: err.code ?? 1, error: err.message });
          else resolve({ stdout, stderr, code: 0 });
        });
      });
    }
    return { stdout: '', stderr: `未知命令：${key}`, code: 1 };
  });

  /* ---------- 端口/进程（结构化，专供 netstat 工具） ---------- */

  ipcMain.handle('tool:netstat', async (): Promise<any> => {
    const ps = (script: string) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', script],
          { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });

    try {
      // 一次拿全量：监听端口 + 所有进程（构建 PID→进程名映射）
      const [portsJson, procsJson] = await Promise.all([
        ps(
          'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort | ConvertTo-Json -Compress',
        ),
        ps('Get-Process | Select-Object Id,ProcessName,@{n="MB";e={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress'),
      ]);

      const parse = (j: string): any[] => {
        const t = j.trim();
        if (!t) return [];
        const arr = JSON.parse(t);
        return Array.isArray(arr) ? arr : [arr];
      };

      const procs = parse(procsJson);
      const pidToName = new Map<string, string>();
      for (const p of procs) pidToName.set(String(p.Id), String(p.ProcessName));

      const ports = parse(portsJson).map((c) => ({
        address: String(c.LocalAddress ?? ''),
        port: Number(c.LocalPort),
        pid: Number(c.OwningProcess),
        process: pidToName.get(String(c.OwningProcess)) ?? '—',
      }));

      // 进程列表按内存降序、取前 100
      const processList = procs
        .sort((a, b) => (Number(b.MB) || 0) - (Number(a.MB) || 0))
        .slice(0, 100)
        .map((p) => ({ pid: Number(p.Id), name: String(p.ProcessName), mb: Number(p.MB) || 0 }));

      return {
        ports: ports.filter((p) => p.port > 0),
        processes: processList,
        count: { ports: ports.length, processes: processList.length },
      };
    } catch (e: any) {
      return { ports: [], processes: [], error: e?.message ?? String(e) };
    }
  });

  /* ---------- 环境变量快照（脱敏） ---------- */

  ipcMain.handle('tool:envSnapshot', async (): Promise<any> => {
    const keys = Object.keys(process.env).sort();
    const entries = keys.map((k) => {
      let v = process.env[k] ?? '';
      // 脱敏：key 或值里含敏感词的整值打码
      const isSensitive = /(key|token|secret|password|passwd|pwd|credential|auth)/i.test(k);
      if (isSensitive && v) v = '<已隐藏>';
      return { key: k, value: v };
    });
    return { entries, count: entries.length };
  });

  /* ---------- 屏幕截图（截图翻译） ---------- */

  ipcMain.handle('tool:captureScreen', async (): Promise<any> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: screen.getPrimaryDisplay().size,
      });
      if (!sources.length) return { ok: false, error: '未找到屏幕源' };
      return { ok: true, dataURL: sources[0].thumbnail.toDataURL() };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
