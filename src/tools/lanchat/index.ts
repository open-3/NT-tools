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
      markRead(peerId: string): Promise<boolean>;
      unreadCount(peerId: string): Promise<number>;
      unreadMap(): Promise<Record<string, number>>;
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
  read: number;
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
/** 待确认的文件接收请求（通过 incoming-offer 事件维护，内联渲染在对话框） */
const pendingOffers = new Map<number, IncomingOffer>();
/** 每个对端的未读计数（peerId → count） */
const unread = new Map<string, number>();

/* ---------- 工具函数 ---------- */

/** 完整时间（年月日 + 时分） */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dd} ${hh}:${mm}`;
}

/** 取名字首个字符（字母/数字/汉字）做头像 */
function avatarChar(name: string): string {
  const s = name.trim();
  if (!s) return '?';
  return s[0];
}

/** 由名字稳定生成一个颜色（HSL 色相），用于头像底色区分不同设备 */
function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
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
      const c = unread.get(p.id) ?? 0;
      const badge = c > 0 ? `<span class="lc-badge">${c > 99 ? '99+' : c}</span>` : '';
      return `
        <div class="lc-peer${active}" data-id="${esc(p.id)}">
          <span class="lc-avatar" data-hue="${avatarHue(p.name)}">${esc(avatarChar(p.name))}</span>
          <div class="pbody">
            <div class="pname">${esc(p.name)}</div>
            <div class="pip">${esc(p.ip)} · ${p.online ? '在线' : '离线'}</div>
          </div>
          <span class="lc-dot${dot}"></span>
          ${badge}
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

  // 头像底色用 CSSOM 设置（hue 是动态值，CSP 禁 inline style）
  box.querySelectorAll<HTMLElement>('.lc-avatar').forEach((el) => {
    el.style.backgroundColor = `hsl(${el.dataset.hue ?? 0} 60% 88%)`;
    el.style.color = `hsl(${el.dataset.hue ?? 0} 55% 32%)`;
  });
}

async function selectPeer(peerId: string): Promise<void> {
  activePeerId = peerId;
  const peer = snapshot.peers.find((p) => p.id === peerId);
  $('chat-title').textContent = peer ? `${peer.name} · ${peer.ip}` : '选择设备';
  // 进入对话即清除未读
  unread.delete(peerId);
  void window.lan.markRead(peerId);
  renderPeers();
  await renderMessages();
}

async function renderMessages(): Promise<void> {
  const box = $('messages');
  if (!activePeerId) {
    box.innerHTML = '<div class="lc-msg centered">选择左侧在线设备开始聊天</div>';
    return;
  }
  const peer = snapshot.peers.find((p) => p.id === activePeerId);
  const peerName = peer?.name ?? '对端';
  const msgs = await window.lan.messages(activePeerId, 200);
  const sorted = [...msgs].reverse(); // store 返回时间降序，转升序

  // 待确认的接收请求（内联到对话框，追加在消息末尾）
  const offers = [...pendingOffers.values()].filter((o) => o.peerId === activePeerId);

  const parts: string[] = sorted.map((m) => renderMessage(m, peerName));
  for (const o of offers) parts.push(renderPendingOffer(o));
  box.innerHTML = parts.length
    ? parts.join('')
    : '<div class="lc-msg centered">还没有消息，打个招呼吧</div>';

  // 文件消息：内联进度条 + 右键菜单（CSP 禁 inline style，用 CSSOM + 事件绑定）
  box.querySelectorAll<HTMLElement>('.lc-bubble.file').forEach((el) => {
    bindFileMessage(el);
  });
  // 待确认请求：绑定接收/拒绝按钮
  box.querySelectorAll<HTMLElement>('.lc-offer').forEach((el) => {
    bindOffer(el);
  });
  // 头像底色 + 文字色
  box.querySelectorAll<HTMLElement>('.lc-avatar').forEach((el) => {
    el.style.backgroundColor = `hsl(${el.dataset.hue ?? 0} 60% 88%)`;
    el.style.color = `hsl(${el.dataset.hue ?? 0} 55% 32%)`;
  });
  box.scrollTop = box.scrollHeight;
}

/** 待确认接收请求的气泡（含接收/拒绝/更改目录按钮） */
function renderPendingOffer(o: IncomingOffer): string {
  const avatar = avatarHtml(o.peerName);
  return `
    <div class="lc-row">
      ${avatar}
      <div class="lc-bubble file lc-offer" data-transfer-id="${o.transferId}" data-peer-id="${esc(o.peerId)}">
        <div class="frow">📄 ${esc(o.fileName)}</div>
        <div class="fpath">${fmtSize(o.size)} · 待接收</div>
        <div class="foffer-actions">
          <button class="lc-btn small" data-act="reject">拒绝</button>
          <button class="lc-btn small" data-act="change">更改目录</button>
          <button class="lc-btn small primary" data-act="accept">接收</button>
        </div>
      </div>
    </div>`;
}

function bindOffer(el: HTMLElement): void {
  const transferId = Number(el.dataset.transferId ?? '0');
  const peerId = el.dataset.peerId ?? '';
  let savePath: string | null = null;

  el.querySelector('[data-act="accept"]')?.addEventListener('click', () => {
    pendingOffers.delete(transferId);
    void window.lan.acceptFile(transferId, true, savePath ?? undefined);
    void renderMessages();
  });
  el.querySelector('[data-act="reject"]')?.addEventListener('click', () => {
    pendingOffers.delete(transferId);
    void window.lan.acceptFile(transferId, false);
    void renderMessages();
  });
  el.querySelector('[data-act="change"]')?.addEventListener('click', () => {
    void window.lan.pickDir().then((dir) => {
      if (dir) savePath = dir;
    });
  });
}

/** 解析文件消息的 meta JSON */
function parseFileMeta(meta: string): { fileName?: string; size?: number; savePath?: string; path?: string; transferId?: number; state?: string } {
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 头像气泡（发送方/接收方各一个） */
function avatarHtml(name: string): string {
  return `<span class="lc-avatar" data-hue="${avatarHue(name)}">${esc(avatarChar(name))}</span>`;
}

function renderMessage(m: Message, peerName: string): string {
  if (m.kind === 'broadcast') {
    return `<div class="lc-msg centered">📢 ${esc(m.text)}</div>`;
  }
  if (m.kind === 'file') {
    const meta = parseFileMeta(m.meta);
    const filePath = meta.savePath ?? meta.path ?? '';
    const progress = buildFileProgress(m, meta);
    const isOut = m.dir === 'out';
    const avatar = isOut ? avatarHtml(snapshot.self.name) : avatarHtml(peerName);
    const body = `
        <div class="frow">📄 ${esc(m.text)}</div>
        ${filePath ? `<div class="fpath" title="${esc(filePath)}">${esc(filePath)}</div>` : ''}
        ${progress}
        <span class="mt">${fmtTime(m.ts)}</span>`;
    const bubble = `<div class="lc-bubble file" data-id="${m.id}" data-path="${esc(filePath)}" data-transfer-id="${meta.transferId ?? ''}" data-state="${esc(meta.state ?? 'done')}" data-dir="${m.dir}">${body}</div>`;
    return isOut
      ? `<div class="lc-row out">${bubble}${avatar}</div>`
      : `<div class="lc-row">${avatar}${bubble}</div>`;
  }
  const isOut = m.dir === 'out';
  const avatar = isOut ? avatarHtml(snapshot.self.name) : avatarHtml(peerName);
  const bubble = `<div class="lc-bubble ${isOut ? 'out' : ''}">${esc(m.text)}<span class="mt">${fmtTime(m.ts)}</span></div>`;
  return isOut
    ? `<div class="lc-row out">${bubble}${avatar}</div>`
    : `<div class="lc-row">${avatar}${bubble}</div>`;
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

/** 收到对方消息时的未读处理：非当前对话 → 未读 +1 并刷新侧栏红点 */
function onIncomingMessage(peerId: string): void {
  if (peerId && peerId !== activePeerId) {
    unread.set(peerId, (unread.get(peerId) ?? 0) + 1);
    renderPeers();
  } else if (activePeerId) {
    void renderMessages();
  }
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

/* 接收确认（改为内联到对话框：incoming-offer 事件进 pendingOffers，渲染时附加在消息末尾） */
function showAcceptInline(offer: IncomingOffer): void {
  pendingOffers.set(offer.transferId, offer);
  // 若当前正在看该对端的对话，立即刷新显示；否则靠侧栏未读提示
  if (offer.peerId === activePeerId) void renderMessages();
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
      case 'message': {
        // message 事件可能带 peerId（见 wire 的 emit('message')，暂不带），
        // 无法确定来源时用当前快照容差处理：直接刷新 + 重算未读。
        void refreshUnread().then(() => renderPeers());
        if (activePeerId) void renderMessages();
        break;
      }
      case 'transfer-progress': {
        const p = payload as TransferProgress;
        transfers.set(p.transferId, p);
        // 进度更新 → 刷新聊天区（内联进度条挂在文件消息下方）
        if (activePeerId) void renderMessages();
        break;
      }
      case 'incoming-offer':
        showAcceptInline(payload as IncomingOffer);
        break;
    }
  });

  snapshot = await window.lan.start();
  renderSelf();
  renderPeers();
  await refreshUnread();
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

  // 广播弹窗
  $('bc-send').addEventListener('click', sendBroadcast);
  $('bc-cancel').addEventListener('click', () => ($('bc-modal').hidden = true));
  $('bc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBroadcast();
  });
}

/** 从主进程拉取所有对端的未读计数，更新本地 unread Map */
async function refreshUnread(): Promise<void> {
  const map = await window.lan.unreadMap();
  for (const [id, c] of Object.entries(map)) {
    if (c > 0) unread.set(id, c);
    else unread.delete(id);
  }
}

void boot();
