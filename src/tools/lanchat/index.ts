/// <reference types="electron" />

/**
 * 局域网通信工具（lanchat）渲染层。
 *
 * 通过 window.lan（preload-lan.ts 暴露）调用主进程的 LanManager。
 * 纯 vanilla DOM，UI 全部走 CSS 类（CSP 禁 inline style）。
 */

declare global {
  interface Window {
    lan: {
      start(): Promise<Snapshot>;
      stop(): Promise<boolean>;
      snapshot(): Promise<Snapshot>;
      sendChat(peerId: string, text: string): Promise<void>;
      broadcast(text: string): Promise<string[]>;
      sendFile(peerId: string, filePath: string): Promise<number>;
      acceptFile(transferId: number, ok: boolean, savePath?: string): Promise<boolean>;
      messages(peerId: string, limit?: number): Promise<Message[]>;
      pickFile(): Promise<string | null>;
      pickDir(): Promise<string | null>;
      listInterfaces(): Promise<NetIface[]>;
      getSelectedInterface(): Promise<NetIface | null>;
      setNic(address: string | null): Promise<NetIface | null>;
      setOnline(on: boolean): Promise<Snapshot>;
      showInFolder(filePath: string): Promise<boolean>;
      on(cb: (channel: string, payload: unknown) => void): () => void;
    };
  }
}

export {};

interface NetIface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
  family: string;
  internal: boolean;
  virtual: boolean;
  apipa: boolean;
}

interface Peer {
  id: string;
  name: string;
  ip: string;
  tcpPort: number;
  lastSeen: number;
  online: boolean;
}

interface Snapshot {
  self: { id: string; name: string; ip: string; tcpPort: number; online: boolean };
  peers: Peer[];
}

interface Message {
  id: number;
  peerId: string;
  dir: 'in' | 'out';
  kind: 'text' | 'broadcast' | 'file';
  text: string;
  meta: string;
  ts: number;
}

interface TransferProgress {
  transferId: number;
  peerId: string;
  dir: 'in' | 'out';
  name: string;
  size: number;
  cur: number;
  state: 'pending' | 'sending' | 'receiving' | 'done' | 'failed';
}

interface IncomingOffer {
  transferId: number;
  peerId: string;
  peerName: string;
  fileName: string;
  size: number;
  kind: 'file' | 'dir';
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let snapshot: Snapshot = { self: { id: '', name: '', ip: '', tcpPort: 0, online: true }, peers: [] };
let activePeerId: string | null = null;
const transfers = new Map<number, TransferProgress>();

/* ---------- 工具函数 ---------- */

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/* ---------- 渲染 ---------- */

function renderSelf(): void {
  const s = snapshot.self;
  $('self-label').textContent = `🛜 ${s.name}`;
  $('self-ip').textContent = s.ip ? `${s.ip}:${s.tcpPort || '…'}` : '';
  renderPresence(s.online);
}

function renderPresence(online: boolean): void {
  const btn = $('btn-presence');
  btn.textContent = online ? '● 在线' : '○ 隐身';
  btn.dataset.online = online ? '1' : '0';
}

function togglePresence(): void {
  const next = snapshot.self.online === false;
  void window.lan.setOnline(next).then((s) => {
    snapshot = s;
    renderSelf();
    renderPeers();
  });
}

function renderPeers(): void {
  const online = snapshot.peers.filter((p) => p.online);
  $('online-count').textContent = `在线 ${online.length}`;

  const box = $('peers');
  if (snapshot.peers.length === 0) {
    box.innerHTML = '<div class="lc-empty">正在扫描局域网…<br/>附近没有发现其他设备</div>';
    return;
  }

  box.innerHTML = snapshot.peers
    .map((p) => {
      const active = p.id === activePeerId ? ' active' : '';
      const dot = p.online ? '' : ' off';
      return `
        <div class="lc-peer${active}" data-id="${esc(p.id)}">
          <span class="lc-dot${dot}"></span>
          <div class="pname">${esc(p.name)}</div>
          <div class="pip">${esc(p.ip)} · ${p.online ? '在线' : '离线'}</div>
        </div>`;
    })
    .join('');

  box.querySelectorAll<HTMLElement>('.lc-peer').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id!;
      const peer = snapshot.peers.find((x) => x.id === id);
      if (peer && peer.online) void selectPeer(id);
    };
  });
}

async function selectPeer(peerId: string): Promise<void> {
  activePeerId = peerId;
  const peer = snapshot.peers.find((p) => p.id === peerId);
  $('chat-title').textContent = peer ? `${peer.name} · ${peer.ip}` : '选择设备';
  renderPeers();
  await renderMessages();
}

async function renderMessages(): Promise<void> {
  const box = $('messages');
  if (!activePeerId) {
    box.innerHTML = '<div class="lc-msg centered">选择左侧在线设备开始聊天</div>';
    return;
  }
  const msgs = await window.lan.messages(activePeerId, 200);
  const sorted = [...msgs].reverse(); // store 返回时间降序，转升序
  box.innerHTML = sorted.length
    ? sorted.map(renderMessage).join('')
    : '<div class="lc-msg centered">还没有消息，打个招呼吧</div>';

  // 文件消息：内联进度条 + 右键菜单（CSP 禁 inline style，用 CSSOM + 事件绑定）
  box.querySelectorAll<HTMLElement>('.lc-msg.file').forEach((el) => {
    bindFileMessage(el);
  });
  box.scrollTop = box.scrollHeight;
}

/** 解析文件消息的 meta JSON */
function parseFileMeta(meta: string): { fileName?: string; size?: number; savePath?: string; path?: string; transferId?: number; state?: string } {
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function renderMessage(m: Message): string {
  if (m.kind === 'broadcast') {
    return `<div class="lc-msg centered">📢 ${esc(m.text)}</div>`;
  }
  if (m.kind === 'file') {
    const meta = parseFileMeta(m.meta);
    const state = meta.state ?? 'done';
    const filePath = meta.savePath ?? meta.path ?? '';
    // 活动传输（sending/receiving）在消息下方渲染进度条
    const progress = buildFileProgress(m, meta);
    return `
      <div class="lc-msg file ${m.dir === 'out' ? 'out' : ''}" data-id="${m.id}" data-path="${esc(filePath)}" data-transfer-id="${meta.transferId ?? ''}" data-state="${esc(state)}" data-dir="${m.dir}">
        <div class="frow">📄 ${esc(m.text)}</div>
        ${filePath ? `<div class="fpath" title="${esc(filePath)}">${esc(filePath)}</div>` : ''}
        ${progress}
        <span class="mt">${fmtTime(m.ts)}</span>
      </div>`;
  }
  return `<div class="lc-msg ${m.dir === 'out' ? 'out' : ''}">${esc(m.text)}<span class="mt">${fmtTime(m.ts)}</span></div>`;
}

/**
 * 根据文件消息的 state + transfers Map 生成内联进度条 HTML。
 *   - state=sending/receiving 且有进度 → 进度条；否则空串。
 *   - done 后不再显示进度条（用户需求）。
 */
function buildFileProgress(m: Message, meta: { transferId?: number; state?: string }): string {
  const t = meta.transferId != null ? transfers.get(meta.transferId) : undefined;
  if (!t || (t.state !== 'sending' && t.state !== 'receiving')) return '';
  const pct = t.size > 0 ? Math.min(100, Math.round((t.cur / t.size) * 100)) : 0;
  const label = t.state === 'sending' ? `发送中 ${pct}%` : `接收中 ${pct}%`;
  return `
    <div class="fprog" data-pct="${pct}">
      <div class="fbar"><i></i></div>
      <div class="fstate">${label} · ${fmtSize(t.cur)} / ${fmtSize(t.size)}</div>
    </div>`;
}

/** 设置文件消息内联进度条宽度 + 绑定右键菜单 */
function bindFileMessage(el: HTMLElement): void {
  const prog = el.querySelector<HTMLElement>('.fprog');
  if (prog) {
    const pct = Number(prog.dataset.pct ?? '0');
    const bar = prog.querySelector<HTMLElement>('i');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showFileMenu(el, e.clientX, e.clientY);
  });
}

/* ---------- 文件右键菜单 ---------- */
let contextMenu: HTMLElement | null = null;

function showFileMenu(el: HTMLElement, x: number, y: number): void {
  hideFileMenu();
  const filePath = el.dataset.path ?? '';

  const menu = document.createElement('div');
  menu.className = 'lc-ctx';
  menu.innerHTML = `
    <div class="lc-ctx-item" data-act="open">📂 打开文件位置</div>
    <div class="lc-ctx-item" data-act="copy">📋 复制路径</div>
  `;
  // 定位用 CSSOM（CSP 禁 inline style）
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  menu.querySelector('[data-act="open"]')?.addEventListener('click', () => {
    if (filePath) void window.lan.showInFolder(filePath);
    hideFileMenu();
  });
  menu.querySelector('[data-act="copy"]')?.addEventListener('click', () => {
    if (filePath) void navigator.clipboard?.writeText(filePath);
    hideFileMenu();
  });

  document.body.appendChild(menu);
  contextMenu = menu;

  // 点击别处关闭
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) hideFileMenu();
  };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.dataset.closeHandler = '1';
}

function hideFileMenu(): void {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
}

/* ---------- 事件 ---------- */

function appendIncomingMessage(): void {
  if (activePeerId) void renderMessages();
}

function submitMessage(): void {
  const input = $<HTMLInputElement>('msg-input');
  const text = input.value.trim();
  if (!text || !activePeerId) return;
  void window.lan
    .sendChat(activePeerId, text)
    .then(() => {
      input.value = '';
      return renderMessages();
    })
    .catch((e: Error) => showError(e?.message ?? '发送失败'));
}

function sendFile(): void {
  if (!activePeerId) {
    showError('请先选择一个在线设备');
    return;
  }
  void window.lan
    .pickFile()
    .then((p) => {
      if (!p) return null;
      return window.lan.sendFile(activePeerId!, p);
    })
    .then(() => {
      void renderMessages();
    })
    .catch((e: Error) => showError(e?.message ?? '发送失败'));
}

function openBroadcast(): void {
  const online = snapshot.peers.filter((p) => p.online);
  $('bc-count').textContent = String(online.length);
  const input = $<HTMLInputElement>('bc-input');
  input.value = '';
  $('bc-modal').hidden = false;
  input.focus();
}

function sendBroadcast(): void {
  const text = $<HTMLInputElement>('bc-input').value.trim();
  if (!text) return;
  void window.lan.broadcast(text).then(() => {
    $('bc-modal').hidden = true;
  });
}

function showError(msg: string): void {
  const box = $('messages');
  const el = document.createElement('div');
  el.className = 'lc-msg centered err';
  el.textContent = `⚠ ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  setTimeout(() => el.remove(), 3000);
}

/* 接收确认弹窗 */
let pendingOffer: IncomingOffer | null = null;
let acceptSavePath: string | null = null;

function showAcceptModal(offer: IncomingOffer): void {
  pendingOffer = offer;
  acceptSavePath = null;
  $('modal-title').textContent = '收到文件';
  $('modal-desc').textContent = `${offer.peerName} 想发送 ${offer.fileName}（${fmtSize(offer.size)}）`;
  $('modal').hidden = false;
}

function acceptFile(ok: boolean): void {
  if (!pendingOffer) return;
  const offer = pendingOffer;
  if (ok) {
    void window.lan.acceptFile(offer.transferId, true, acceptSavePath ?? undefined);
  } else {
    void window.lan.acceptFile(offer.transferId, false);
  }
  $('modal').hidden = true;
  pendingOffer = null;
  acceptSavePath = null;
}

/* ---------- 网卡选择 ---------- */

async function renderNicSelector(): Promise<void> {
  const sel = $<HTMLSelectElement>('nic-select');
  if (!sel) return;

  const [ifaces, cur] = await Promise.all([
    window.lan.listInterfaces(),
    window.lan.getSelectedInterface(),
  ]);

  // 只显示可用的非虚拟网卡（虚拟/APIPA 仍列出但标记，供极端情况手动选）
  const items = ifaces.filter((i) => !i.virtual);
  const shown = items.length ? items : ifaces;

  sel.innerHTML = '';
  // 自动选项
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = '自动检测';
  sel.appendChild(autoOpt);

  for (const i of shown) {
    const opt = document.createElement('option');
    opt.value = i.address;
    const tag = i.virtual ? '（虚拟）' : i.apipa ? '（无网）' : '';
    opt.textContent = `${i.name} · ${i.address}${tag}`;
    sel.appendChild(opt);
  }

  // 居中选中的：有手动指定 → 选它；否则选「自动」
  const override = cur ? (shown.some((i) => i.address === cur.address) || shown.some((i) => i.name === cur.name) ? cur : null) : null;
  sel.value = override ? cur!.address : '';
}

function bindNicSelector(): void {
  const sel = $<HTMLSelectElement>('nic-select');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const v = sel.value || null;
    void window.lan.setNic(v).then(() => {
      // 网卡切换后立即刷新快照
      void window.lan.snapshot().then((s) => {
        snapshot = s;
        renderSelf();
        renderPeers();
      });
    });
  });
}

/* ---------- 启动 ---------- */

async function boot(): Promise<void> {
  // 订阅主进程 push 事件
  window.lan.on((channel, payload) => {
    switch (channel) {
      case 'snapshot':
        snapshot = payload as Snapshot;
        renderSelf();
        renderPeers();
        break;
      case 'message':
        appendIncomingMessage();
        break;
      case 'transfer-progress': {
        const p = payload as TransferProgress;
        transfers.set(p.transferId, p);
        // 进度更新 → 刷新聊天区（内联进度条挂在文件消息下方）
        if (activePeerId) void renderMessages();
        break;
      }
      case 'incoming-offer':
        showAcceptModal(payload as IncomingOffer);
        break;
    }
  });

  snapshot = await window.lan.start();
  renderSelf();
  renderPeers();
  await renderMessages();
  await renderNicSelector();
  bindNicSelector();

  // 输入
  $('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitMessage();
  });
  $('btn-send-msg').addEventListener('click', submitMessage);
  $('btn-send').addEventListener('click', sendFile);
  $('btn-broadcast').addEventListener('click', openBroadcast);
  $('btn-presence').addEventListener('click', togglePresence);
  $('btn-refresh').addEventListener('click', () => {
    void window.lan.snapshot().then((s) => {
      snapshot = s;
      renderSelf();
      renderPeers();
    });
  });

  // 弹窗
  $('bc-send').addEventListener('click', sendBroadcast);
  $('bc-cancel').addEventListener('click', () => ($('bc-modal').hidden = true));
  $('bc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBroadcast();
  });

  $('modal-accept').addEventListener('click', () => acceptFile(true));
  $('modal-reject').addEventListener('click', () => acceptFile(false));
  $('modal-change').addEventListener('click', () => {
    void window.lan.pickDir().then((dir) => {
      if (dir) acceptSavePath = dir;
    });
  });
}

void boot();
