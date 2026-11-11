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
      on(cb: (channel: string, payload: unknown) => void): () => void;
    };
  }
}

export {};

interface Peer {
  id: string;
  name: string;
  ip: string;
  tcpPort: number;
  lastSeen: number;
  online: boolean;
}

interface Snapshot {
  self: { id: string; name: string; ip: string; tcpPort: number };
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

let snapshot: Snapshot = { self: { id: '', name: '', ip: '', tcpPort: 0 }, peers: [] };
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
    ? sorted
        .map((m) => {
          if (m.kind === 'broadcast') {
            return `<div class="lc-msg centered">📢 ${esc(m.text)}</div>`;
          }
          if (m.kind === 'file') {
            return `<div class="lc-msg ${m.dir === 'out' ? 'out' : ''}">📄 ${esc(m.text)}<span class="mt">${fmtTime(m.ts)}</span></div>`;
          }
          return `<div class="lc-msg ${m.dir === 'out' ? 'out' : ''}">${esc(m.text)}<span class="mt">${fmtTime(m.ts)}</span></div>`;
        })
        .join('')
    : '<div class="lc-msg centered">还没有消息，打个招呼吧</div>';
  box.scrollTop = box.scrollHeight;
}

function renderTransfers(): void {
  const box = $('transfers');
  const list = [...transfers.values()];
  if (!list.length) {
    box.classList.remove('has');
    box.innerHTML = '';
    return;
  }
  box.classList.add('has');
  box.innerHTML = list
    .map((t) => {
      const pct = t.size > 0 ? Math.min(100, Math.round((t.cur / t.size) * 100)) : 0;
      const stateCls = t.state === 'done' ? ' ok' : t.state === 'failed' ? ' err' : '';
      const barCls = t.state === 'done' ? ' done' : t.state === 'failed' ? ' err' : '';
      const stateText =
        t.state === 'done'
          ? '完成'
          : t.state === 'failed'
            ? '失败'
            : t.state === 'sending' || t.state === 'receiving'
              ? `${pct}%`
              : '等待中';
      const dirTag = t.dir === 'out' ? '发送' : '接收';
      return `
        <div class="lc-tx" data-id="${t.transferId}">
          <div class="trow">
            <span class="tname">${dirTag} · ${esc(t.name)}</span>
            <span class="tsize">${fmtSize(t.cur)} / ${fmtSize(t.size)}</span>
          </div>
          <div class="lc-bar${barCls}"><i></i></div>
          <div class="tstate${stateCls}">${stateText}</div>
        </div>`;
    })
    .join('');

  // 进度条宽度用 CSSOM 设置（CSP 禁 inline style）
  box.querySelectorAll<HTMLElement>('.lc-tx').forEach((el) => {
    const id = Number(el.dataset.id);
    const t = transfers.get(id);
    if (!t) return;
    const pct = t.size > 0 ? Math.min(100, Math.round((t.cur / t.size) * 100)) : 0;
    const bar = el.querySelector<HTMLElement>('i');
    if (bar) bar.style.width = `${pct}%`;
  });
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
        renderTransfers();
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

  // 输入
  $('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitMessage();
  });
  $('btn-send-msg').addEventListener('click', submitMessage);
  $('btn-send').addEventListener('click', sendFile);
  $('btn-broadcast').addEventListener('click', openBroadcast);
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
