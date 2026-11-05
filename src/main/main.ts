import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, globalShortcut, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Store } from './store';
import { CodexAdapter } from './adapters/codex';
import { DshAdapter } from './adapters/dsh';
import { WorkBuddyAdapter } from './adapters/workbuddy';
import { AgentAdapter, AgentSession, SourceStatus } from './adapters/types';
import { reconcile, sameSnapshot, ViewSnapshot } from './reconcile';
import { AutoCollapse } from './autocollapse';
import { readQuota } from './quota';
import { QuotaState } from './adapters/types';
import { showToolboxMenu, installToolIpc } from './tools';

const WIDTH = 362;
const HEADER_H = 42;
const FOOTER_H = 30;
const ITEM_H = 53;
const LIST_PAD = 5;
const EMPTY_H = 74;
/**
 * 列表高度上限（约 11 条）。
 *
 * 卡片是按内容自适应的，但条数一多窗口会长到屏幕外：实测 30 条 = 972px、
 * 50 条 = 1988px，而 1280 屏可用高度只有 1232px —— 底部条目永远看不到。
 * 超过上限时改由列表内部滚动（style.css 的 `.p-list` 同步设了 max-height）。
 *
 * 取 600 而不是 538：11 条是「10 条未完成 + 1 行已完成折叠」的常见上限，
 * 这样折叠行不会被挤出视野。整窗 600+42+30 = 672px，768p 笔记本仍放得下。
 */
const LIST_MAX_H = 600;
/**
 * Windows 上 BrowserWindow 存在一个约 38px 的最小高度下限（实测请求 24/30/32/34/36
 * 都只能得到 38）。所以折叠态按 38 设计，内容区 32 + 上下各 3px 透明留白，
 * 视觉上仍是细条，且不会因为抢不到高度而出现内容裁切。
 */
const MINI_H = 40;

const isDev = process.argv.includes('--dev');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let lastSnapshot: ViewSnapshot | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let watchers: fs.FSWatcher[] = [];
let watchDebounce: NodeJS.Timeout | null = null;
let quitting = false;
let lastRenderedHeight = 0;
let quotaCache: QuotaState | undefined;
let quotaTimer: NodeJS.Timeout | null = null;

const adapters: AgentAdapter[] = [new CodexAdapter(), new DshAdapter(), new WorkBuddyAdapter()];

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

function collect(): ViewSnapshot {
  const sessions: AgentSession[] = [];
  const sources: SourceStatus[] = [];

  for (const a of adapters) {
    let ok = false;
    let err: string | undefined;
    let rows: AgentSession[] = [];
    try {
      ok = a.detect();
      if (ok) rows = a.snapshot();
    } catch (e: any) {
      err = e?.message ?? String(e);
      rows = [];
    }
    sessions.push(...rows);
    sources.push({ id: a.id, label: a.label, ok, count: rows.length, error: err });
  }

  const snap = reconcile(sessions, sources, store);
  // 额度用独立定时器算（低频），这里只贴上去，不阻塞列表的 2s 刷新
  if (quotaCache) snap.quota = quotaCache;
  store.pruneKeys(new Set(sessions.map((s) => s.key)));
  return snap;
}

/* ------------------------------------------------------------------ */
/* 额度（独立低频定时器）                                               */
/* ------------------------------------------------------------------ */

/**
 * 为什么独立跑：读 rollout 尾部有 I/O，不该阻塞列表的 2s 轮询。
 * 额度百分比变化得很慢，60 秒查一次足够。
 */
const QUOTA_INTERVAL = 60_000;

function refreshQuota(): void {
  try {
    quotaCache = readQuota();
  } catch (e) {
    console.error('[pulse] quota read failed', e);
    quotaCache = undefined;
  }

  /*
   * 不要调 refresh() —— 那会重跑全部适配器。额度只是「贴到已有快照上」，
   * 所以直接把新值塞进 lastSnapshot 再重推一次即可。
   */
  if (!lastSnapshot) return;
  const prevPct = lastSnapshot.quota?.primary.usedPct;
  lastSnapshot.quota = quotaCache;

  if (prevPct !== lastSnapshot.quota?.primary.usedPct && win && !win.isDestroyed()) {
    win.webContents.send('pulse:update', lastSnapshot);
  }
}

function scheduleQuota(): void {
  if (quotaTimer) clearInterval(quotaTimer);
  setTimeout(() => {
    refreshQuota();
    quotaTimer = setInterval(refreshQuota, QUOTA_INTERVAL);
  }, 1500);
}

function refresh(force = false): void {
  const snap = collect();
  const changed = force || !sameSnapshot(lastSnapshot, snap);
  lastSnapshot = snap;

  if (changed && win && !win.isDestroyed()) {
    win.webContents.send('pulse:update', snap);
  }
  if (changed) autoCollapse?.tick();
  updateTray(snap);
}

function schedulePoll(): void {
  if (pollTimer) clearInterval(pollTimer);
  const tick = () => {
    try {
      refresh();
    } catch (e) {
      console.error('[pulse] refresh failed', e);
    }
  };
  tick();
  pollTimer = setInterval(tick, 2000);
}

/** 监听会话目录，文件变化时立即刷新（防抖 300ms） */
function installWatchers(): void {
  const home = app.getPath('home');
  const targets = [
    path.join(home, '.dsh', 'sessions'),
    path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions'),
    path.join(home, '.codex', 'sessions'),
  ];

  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { recursive: true, persistent: false }, () => {
        if (watchDebounce) return;
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          refresh();
        }, 300);
      });
      watchers.push(w);
    } catch {
      /* 某些目录不支持递归监听，退回纯轮询 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 预估窗口高度。
 *
 * 只是「渲染完成前的初值」—— 渲染层会在布局稳定后把实测高度回传（`pulse:height`），
 * 以实测为准。所以这里只要算得接近，避免明显的跳动即可。
 *
 * 三个容易算错的地方：
 *  1. `.p-list` 上下各有 5px padding，要算进去；
 *  2. `.p-list` 的 max-height 是 border-box（含 padding），封顶时不能再加 padding；
 *  3. 完成未读超过 3 条会折成一行（34px），不能按条数全算。
 */
function computeHeight(snap: ViewSnapshot): number {
  const st = store.get();
  if (st.collapsed) return MINI_H;
  if (snap.items.length === 0) return HEADER_H + EMPTY_H;

  const done = snap.items.filter((s) => s.state === 'done_unread').length;
  const folded = done > 3;
  const rows = snap.items.length - (folded ? done : 0) + (folded ? 1 : 0);

  const listH = Math.min(rows * ITEM_H + LIST_PAD * 2, LIST_MAX_H);
  return HEADER_H + listH + FOOTER_H + 2; // +2 是容器上下边框
}

function defaultPosition(h: number) {
  const disp = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(disp.x + disp.width - WIDTH - 24),
    y: Math.round(disp.y + Math.max(60, disp.height * 0.16)),
  };
}

function createWindow(): void {
  const st = store.get();
  const saved = st.window ?? { width: WIDTH };
  const h = MINI_H;
  const pos = {
    x: saved.x ?? defaultPosition(h).x,
    y: saved.y ?? defaultPosition(h).y,
  };

  // 确保位置仍在可见屏幕内（换显示器/分辨率变化后）
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    return pos.x + WIDTH > a.x && pos.x < a.x + a.width && pos.y + 40 > a.y && pos.y < a.y + a.height;
  });
  if (!visible) {
    Object.assign(pos, defaultPosition(h));
  }

  win = new BrowserWindow({
    width: WIDTH,
    height: h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: st.alwaysOnTop,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (st.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win?.showInactive();
    // 首次按真实内容调整高度
    setTimeout(() => {
      if (lastSnapshot) applyHeight(computeHeight(lastSnapshot), true);
    }, 60);
  });

  win.on('moved', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    store.patch({ window: { x, y, width: WIDTH } });
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  // 阻止窗口内导航/新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function applyHeight(h: number, force = false): void {
  if (!win || win.isDestroyed()) return;
  const target = Math.max(MINI_H, Math.round(h));
  if (!force && Math.abs(target - lastRenderedHeight) < 1) return;
  lastRenderedHeight = target;
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: WIDTH, height: target }, false);
}

/**
 * 空态自动折叠：列表为空持续 2s 后收起成细条；一旦重新有内容就自动展开。
 * 只作用于「自动」折叠，用户手动折叠/展开的状态不会被覆盖。
 */
let autoCollapse: AutoCollapse | null = null;

function initAutoCollapse(): void {
  autoCollapse = new AutoCollapse(
    {
      isEmpty: () => (lastSnapshot?.items.length ?? 0) === 0,
      isManuallyCollapsed: () => store.get().collapsed,
      collapse: () => {
        win?.webContents.send('pulse:state', { alwaysOnTop: store.get().alwaysOnTop, collapsed: true });
        applyHeight(MINI_H, true);
      },
      expand: () => {
        win?.webContents.send('pulse:state', { alwaysOnTop: store.get().alwaysOnTop, collapsed: false });
        if (lastSnapshot) applyHeight(computeHeight(lastSnapshot), true);
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
    },
    2000,
  );
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

/** 程序化绘制托盘图标：一个圆环，attention 时变成琥珀色实心点 */
function trayIcon(attention: boolean): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const outer = 12;
  const inner = attention ? 0 : 6.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * size + x) * 4;
      let a = 0;
      if (d <= outer && d >= inner) {
        // 边缘抗锯齿
        const edge = Math.min(outer - d, d - inner);
        a = Math.max(0, Math.min(1, edge)) * 255;
      }
      // BGRA
      buf[i] = attention ? 0x20 : 0xdc; // B
      buf[i + 1] = attention ? 0xb0 : 0xdc; // G
      buf[i + 2] = attention ? 0xff : 0x3d; // R
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray(snap: ViewSnapshot): void {
  if (!tray) return;
  const n = snap.counts.total;
  tray.setToolTip(
    n === 0 ? 'Agent Pulse · 暂无进行中的对话' : `Agent Pulse · ${snap.counts.waiting} 待确认 / ${snap.counts.running} 进行中 / ${snap.counts.done} 未读`,
  );
  tray.setImage(trayIcon(snap.attention));
}

function buildTrayMenu(): void {
  if (!tray) return;
  const st = store.get();
  const menu = Menu.buildFromTemplate([
    {
      label: win?.isVisible() ? '隐藏浮窗' : '显示浮窗',
      click: () => toggleVisible(),
    },
    { type: 'separator' },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: st.alwaysOnTop,
      click: (item) => {
        store.patch({ alwaysOnTop: item.checked });
        applyAlwaysOnTop(item.checked);
      },
    },
    {
      label: '折叠为细条',
      type: 'checkbox',
      checked: st.collapsed,
      click: (item) => {
        store.patch({ collapsed: item.checked });
        if (lastSnapshot) applyHeight(computeHeight(lastSnapshot), true);
        win?.webContents.send('pulse:state', { alwaysOnTop: store.get().alwaysOnTop, collapsed: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: '全部标记已读',
      click: () => {
        const now = Date.now();
        for (const s of lastSnapshot?.items ?? []) store.ack(s.key, now);
        refresh(true);
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: st.autostart,
      click: (item) => {
        store.patch({ autostart: item.checked });
        applyAutostart(item.checked);
      },
    },
    {
      label: '清除已读/忽略记录',
      click: () => {
        store.clearAcks();
        refresh(true);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function applyAlwaysOnTop(on: boolean): void {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(on, on ? 'floating' : 'normal');
  if (on) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  else win.setVisibleOnAllWorkspaces(false);
}

/** 开机自启：开发态（electron.exe + 参数）走启动文件夹快捷方式，打包后走注册表 */
function applyAutostart(on: boolean): void {
  try {
    if (!app.isPackaged) {
      const startup = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const lnk = path.join(startup, 'Agent Pulse.lnk');
      if (!on) {
        fs.rmSync(lnk, { force: true });
        return;
      }
      // 用 PowerShell 生成快捷方式，避免引入额外原生依赖
      const { execFile } = require('node:child_process');
      const target = process.execPath;
      const args = `"${app.getAppPath()}"`;
      const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnk}');$s.TargetPath='${target}';$s.Arguments='${args}';$s.WorkingDirectory='${path.dirname(app.getAppPath())}';$s.Save()`;
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], () => {});
      return;
    }
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath });
  } catch {
    /* 自启失败不影响主功能 */
  }
}

function toggleVisible(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.showInactive();
  }
  buildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function installIpc(): void {
  ipcMain.handle('pulse:get', () => lastSnapshot ?? collect());

  ipcMain.on('pulse:height', (_e, h: number) => {
    if (typeof h === 'number' && isFinite(h)) applyHeight(h);
  });

  ipcMain.on('pulse:ack', (_e, key: string) => {
    if (typeof key !== 'string') return;
    store.ack(key, Date.now());
    refresh(true);
  });

  ipcMain.on('pulse:ackAll', () => {
    const now = Date.now();
    for (const s of lastSnapshot?.items ?? []) store.ack(s.key, now);
    refresh(true);
  });

  ipcMain.on('pulse:ignore', (_e, key: string, minutes: number) => {
    if (typeof key !== 'string') return;
    const until = minutes >= 999999 ? Number.MAX_SAFE_INTEGER : Date.now() + minutes * 60_000;
    store.ignore(key, until);
    refresh(true);
  });

  ipcMain.on('pulse:itemMenu', (e, key: string, title: string) => {
    if (typeof key !== 'string' || !win) return;

    // 找到该会话，判断是否有可复制的摘要
    const session = lastSnapshot?.items.find((s) => s.key === key);

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (session?.resultSummary) {
      template.push({
        label: '复制结果摘要',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(`${session.title}\n${session.resultSummary}`);
        },
      });
      template.push({ type: 'separator' });
    }

    template.push(
      {
        label: '标记已读',
        click: () => {
          store.ack(key, Date.now());
          refresh(true);
        },
      },
      { type: 'separator' },
      {
        label: '本次忽略（1 小时）',
        click: () => {
          store.ignore(key, Date.now() + 60 * 60_000);
          refresh(true);
        },
      },
      {
        label: '永久忽略此会话',
        click: () => {
          store.ignore(key, Number.MAX_SAFE_INTEGER);
          refresh(true);
        },
      },
      { type: 'separator' },
      {
        label: '复制会话 ID',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(key);
        },
      },
    );

    Menu.buildFromTemplate(template).popup({ window: win });
  });


  ipcMain.on('pulse:mainMenu', () => {
    if (!win) return;
    buildTrayMenu();
    tray?.popUpContextMenu();
  });

  ipcMain.on('pulse:collapse', (_e, collapsed: boolean) => {
    store.patch({ collapsed: !!collapsed });
    autoCollapse?.onManualToggle();
    if (lastSnapshot) applyHeight(computeHeight(lastSnapshot), true);
    buildTrayMenu();
  });

  ipcMain.on('pulse:toggleTop', () => {
    const next = !store.get().alwaysOnTop;
    store.patch({ alwaysOnTop: next });
    applyAlwaysOnTop(next);
    buildTrayMenu();
    win?.webContents.send('pulse:state', { alwaysOnTop: next, collapsed: store.get().collapsed });
  });

  ipcMain.on('pulse:hide', () => {
    win?.hide();
    buildTrayMenu();
  });

  ipcMain.on('pulse:quit', () => {
    quitting = true;
    app.quit();
  });

  ipcMain.handle('pulse:state', () => ({
    alwaysOnTop: store.get().alwaysOnTop,
    collapsed: store.get().collapsed,
  }));

  // 工具箱按钮：弹出工具菜单（挂在浮窗上）
  ipcMain.on('pulse:toolbox', () => {
    showToolboxMenu(win ?? null);
  });

  // 工具窗口的打开/保存/另存
  installToolIpc();
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.showInactive();
  });

  app.whenReady().then(() => {
    store = new Store();
    initAutoCollapse();

    if (process.platform === 'win32') {
      app.setAppUserModelId('com.agentpulse.app');
    }

    createWindow();
    installIpc();

    tray = new Tray(trayIcon(false));
    tray.setToolTip('Agent Pulse');
    tray.on('click', () => toggleVisible());
    buildTrayMenu();

    globalShortcut.register('Alt+Shift+A', () => toggleVisible());
    globalShortcut.register('Alt+Shift+C', () => {
      const next = !store.get().collapsed;
      store.patch({ collapsed: next });
      if (lastSnapshot) applyHeight(computeHeight(lastSnapshot), true);
      win?.webContents.send('pulse:state', { alwaysOnTop: store.get().alwaysOnTop, collapsed: next });
      buildTrayMenu();
    });

    installWatchers();
    schedulePoll();
    scheduleQuota();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    store?.flush();
    if (pollTimer) clearInterval(pollTimer);
    if (quotaTimer) clearInterval(quotaTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    globalShortcut.unregisterAll();
  });

  // 有监听器就足以阻止 Electron 在关窗时自动退出（浮窗是隐藏不是关闭）。
  // 这个事件不带 event 参数，所以不能 preventDefault，注册空监听即可。
  app.on('window-all-closed', () => {
    /* 保持后台驻留 */
  });
}
