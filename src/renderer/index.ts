// 空导出让本文件成为「模块」：`declare global` 只能出现在模块里。
// 移除 fmtTokens（token 统计已下架）后本文件一度没有任何 export，
// 变成普通脚本，导致 declare global + window.pulse 全部报错。
export {};

interface AgentSession {
  key: string;
  agent: string;
  agentLabel: string;
  badge: string;
  title: string;
  project: string;
  state: 'waiting_user' | 'running' | 'done_unread';
  stateSince: number;
  lastActivityAt: number;
  confidence: 'exact' | 'inferred';
  activity?: { kind: string; label: string; detail?: string };
  pending?: { kind: string; reason?: string; since: number };
  unread?: boolean;
  resultSummary?: string;
  context?: { project: string; branch?: string };
  changedFiles?: number;
  stallLevel?: 'ok' | 'stall' | 'stuck';
  progress?: { turn?: number; stepSince?: number };
}

interface Snapshot {
  items: AgentSession[];
  sources: { id: string; label: string; ok: boolean; count: number; error?: string }[];
  counts: { waiting: number; running: number; done: number; total: number };
  attention: boolean;
  /** 额度状态（可选，目前只有 Codex 提供） */
  quota?: {
    primary: { usedPct: number; windowMin: number; resetsAt: number };
    secondary?: { usedPct: number; windowMin: number; resetsAt: number };
    plan?: string;
    sampledAt: number;
  };
}

declare global {
  interface Window {
    pulse: {
      get(): Promise<Snapshot>;
      state(): Promise<{ alwaysOnTop: boolean; collapsed: boolean }>;
      ack(key: string): void;
      ackAll(): void;
      ignore(key: string, minutes: number): void;
      itemMenu(key: string, title: string): void;
      mainMenu(): void;
      toolbox(): void;
      collapse(v: boolean): void;
      toggleTop(): void;
      hide(): void;
      quit(): void;
      setHeight(h: number): void;
      onUpdate(cb: (s: Snapshot) => void): void;
      onState(cb: (s: { alwaysOnTop: boolean; collapsed: boolean }) => void): void;
      onUpdateEvent(cb: (s: UpdateEvent) => void): void;
      updateNow(): void;
      updateRestart(): void;
    };
  }
}

/** 主进程 updater 推给渲染层的更新事件 */
interface UpdateEvent {
  state: 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
}

const root = document.getElementById('root')!;
let collapsed = false;
let snapshot: Snapshot | null = null;
let timerHandle: number | null = null;
let breatheTimer: number | null = null;
let breatheOn = false;
/** 完成未读是否已展开（默认折叠） */
let doneExpanded = false;
/** 更新下载状态（胶囊徽章数据），null 表示无进行中的更新 */
let updateStatus: { phase: 'available' | 'downloading' | 'downloaded'; version?: string; percent: number } | null = null;

/* ---------------- 工具 ---------------- */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * 工具图标：<svg> 内联（CSP img-src 为 none，不能用 <img>，但内联 SVG 是 HTML 元素）。
 * 每个 agent 一个辨识度高的简洁图标，替代原来难懂的单个字母。
 */
function badgeIcon(agent: string): string {
  switch (agent) {
    case 'codex':
      // 代码符号 </> 风格
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l-4 3 4 3"/><path d="M16 9l4 3-4 3"/><path d="M13 6l-2 12"/></svg>';
    case 'dsh':
      // 终端提示符 >_
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>';
    case 'workbuddy':
      // 公文包
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></svg>';
    case 'devin':
      // 机器人/齿轮圈
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="12" rx="2"/><path d="M12 7V4"/><circle cx="12" cy="4" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>';
    default:
      return '';
  }
}

/** 相对时间：<60s 显示秒，<60m 显示分，<24h 显示时，否则天 */
function relTime(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 完成未读的可见窗口（与 reconcile 的 DONE_WINDOW_MS 一致） */
const DONE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 完成未读还剩多久可见（ms）。<=0 表示已过期 */
function doneRemaining(s: AgentSession): number {
  return DONE_WINDOW_MS - (Date.now() - s.stateSince);
}

/** 停滞文案：运行中会话「多久没动了」 */
function stallText(s: AgentSession): string {
  const lull = Date.now() - s.lastActivityAt;
  const m = Math.floor(lull / 60000);
  if (m < 1) return '';
  if (s.stallLevel === 'stuck') return `可能卡住 · 已停 ${m} 分钟`;
  return `已停 ${m} 分钟`;
}

/* ---------------- 渲染 ---------------- */

function renderMini(snap: Snapshot): string {
  const c = snap.counts;
  const parts: string[] = [];
  // 注意：不能写内联 style —— 页面的 CSP 是 style-src 'self'，内联样式会被直接拦掉
  // （表现为折叠态的分隔符变成纯文本、圆点尺寸失效）。统一走 CSS 类。
  if (c.waiting > 0) parts.push(`<span class="dot wait"></span>${c.waiting} 待确认`);
  if (c.running > 0) parts.push(`<span class="dot run"></span>${c.running} 进行中`);
  if (c.done > 0) parts.push(`<span class="dot done"></span>${c.done} 未读`);
  const label = parts.length ? parts.join('<span class="mini-sep">·</span>') : '暂无进行中的对话';

  return `
    <div class="pulse">
      <div class="mini-in">
        <div class="logo"></div>
        <div class="mini-count">${label}</div>
        <div class="mini-spacer"></div>
        <div class="icon-btn" data-act="expand" title="展开">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 14.5l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    </div>`;
}

function renderItem(s: AgentSession): string {
  const cls = [
    'item',
    s.state === 'waiting_user' ? 'wait' : '',
    s.state === 'running' ? 'run' : '',
    s.state === 'done_unread' ? 'done' : '',
    s.confidence === 'inferred' ? 'inferred' : '',
    s.stallLevel === 'stall' ? 'stall' : '',
    s.stallLevel === 'stuck' ? 'stuck' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const dotCls = s.state === 'waiting_user' ? 'wait' : s.state === 'running' ? 'run' : 'done';

  let meta = '';
  if (s.state === 'waiting_user') {
    const reason = s.pending?.reason || (s.pending?.kind === 'question' ? '等待回答' : '等待授权');
    const kindLabel = s.pending?.kind === 'question' ? '等待回答' : '等待授权';
    meta = `<b>${esc(kindLabel)}</b>${reason && reason !== kindLabel ? `<span class="sep">·</span>${esc(reason)}` : ''}`;
  } else if (s.state === 'running') {
    const label = s.activity?.label || '处理中';
    const detail = s.activity?.detail || '';
    const turnHtml =
      s.progress && typeof s.progress.turn === 'number' && s.progress.turn > 0
        ? `<span class="sep">·</span><span class="turn">第 ${s.progress.turn} 轮</span>`
        : '';
    const adv = detail
      ? `${esc(label)}<span class="sep">·</span>${esc(detail)}${turnHtml}`
      : `${esc(label)}${turnHtml}`;
    meta = adv;
  } else {
    // 跑完了：优先显示结果摘要（不点开就知道它给了什么）；
    // 拿不到摘要时保持原文案，不假装
    meta = s.resultSummary
      ? `<span class="result">${esc(s.resultSummary)}</span>`
      : '已完成 · 未读';
  }

  // 项目上下文：只在标题行显示项目名（弱化、限宽）。
  // 分支不放在标题行 —— 实测项目名+分支+文件数会把标题挤到 76px，
  // 反而看不清会话本身。分支改放到第二行，与动作/摘要并列。
  const ctx = s.context;
  const ctxHtml = ctx ? `<span class="ctx" title="${esc(ctx.project)}">${esc(ctx.project)}</span>` : '';

  // 改动文件数：只有 Codex 能统计。没有就不显示。
  const filesHtml =
    typeof s.changedFiles === 'number' && s.changedFiles > 0
      ? `<span class="files">${s.changedFiles} 文件</span>`
      : '';

  // 停滞提示：运行中会话「很久没动」，超阈值才出现
  const stallHtml =
    s.state === 'running' && s.stallLevel && s.stallLevel !== 'ok'
      ? `<span class="stall">${esc(stallText(s))}</span>`
      : '';

  // 过期预警：完成未读快滚出 2h 窗口时提示
  const remaining = s.state === 'done_unread' ? doneRemaining(s) : Infinity;
  const expiryHtml =
    remaining > 0 && remaining < 15 * 60 * 1000
      ? `<span class="expiry">还剩 ${Math.ceil(remaining / 60000)} 分钟</span>`
      : '';

  return `
    <div class="${cls}" data-key="${esc(s.key)}">
      <div class="bar"></div>
      <div class="badge badge-${esc(s.agent)}">${badgeIcon(s.agent)}</div>
      <div class="body">
        <div class="agent" title="${esc(s.agentLabel)}">${esc(s.agentLabel)}</div>
        <div class="r1">
          <div class="title" title="${esc(s.title)}">${esc(s.title)}</div>
          ${ctxHtml}
          <div class="time">${relTime(s.stateSince)}</div>
        </div>
        <div class="r2">
          <div class="dot ${dotCls}"></div>
          <div class="meta">${meta}${
            s.context?.branch ? `<span class="sep">·</span><span class="ctx-branch">⎇ ${esc(s.context.branch)}</span>` : ''
          }</div>
          ${stallHtml}
          ${expiryHtml}
          ${filesHtml}
        </div>
      </div>
      <div class="act" data-ack="${esc(s.key)}">已读</div>
    </div>`;
}

function renderFull(snap: Snapshot): string {
  const c = snap.counts;

  // 完成未读超过 3 条时折叠成一行，避免把真正要处理的挤出视野。
  // 注意是「折叠」不是「隐藏」—— 点开仍能看到。
  const doneItems = snap.items.filter((s) => s.state === 'done_unread');
  const activeItems = snap.items.filter((s) => s.state !== 'done_unread');
  const collapseDone = doneItems.length > 3 && !doneExpanded;

  const activeHtml = activeItems.map(renderItem).join('');
  const doneHtml = collapseDone
    ? `<div class="done-fold" data-act="toggleDone">
         <span class="done-fold-dot"></span>
         ${doneItems.length} 项已完成未读
         <span class="done-fold-hint">展开</span>
       </div>`
    : doneItems.map(renderItem).join('');

  const listHtml = activeHtml + doneHtml;

  // 空态：探测是自动的、静默的，不把「未检测到 XX」这种内部状态暴露给用户。
  // 工具没装是常态，不是错误；统一给一个中性文案即可。
  const body =
    snap.items.length === 0
      ? `<div class="p-empty"><div class="ring"></div>暂无进行中的对话</div>`
      : `<div class="p-list">${listHtml}</div>`;

  const footer =
    snap.items.length === 0
      ? ''
      : `<div class="p-foot">
           <div class="foot-left">
             <div class="hint"><kbd>Alt</kbd><kbd>Shift</kbd><kbd>A</kbd> 显隐</div>
             ${quotaAlert(snap)}
           </div>
           <div>${countSummary(c)}</div>
         </div>`;

  return `
    <div class="pulse">
      <div class="p-head">
        <div class="logo"></div>
        <div class="brand">Agent Pulse</div>
        <div class="head-spacer"></div>
        <div class="pill-wait" ${c.waiting > 0 ? '' : 'hidden'}><i></i>${c.waiting} 待确认</div>
        <button class="toolbox-btn" data-act="toolbox" title="工具箱：JSON 格式化等小工具">
          <svg class="toolbox-ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h4v1H5v8h14v-8h-3V7h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/>
            <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2h-2V5h-2v2z"/>
          </svg>
          <span>工具</span>
        </button>
        <div class="icon-btn" data-act="collapse" title="折叠 (Alt+Shift+C)">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="icon-btn" data-act="menu" title="更多">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>
          </svg>
        </div>
      </div>
      ${body}
      ${footer}
      ${updateBarHtml()}
    </div>`;
}

/**
 * 更新胶囊徽章：三态显示，对齐参考截图的设计。
 *   - available：  「↑ 更新」            （可点击 → 立即下载）
 *   - downloading：「↑ 正在下载... X%」  （不可点）
 *   - downloaded： 「点击重启」           （可点击 → 重启安装）
 */
function updateBarHtml(): string {
  if (!updateStatus) return '';
  const pct = Math.max(0, Math.min(100, Math.round(updateStatus.percent ?? 0)));

  if (updateStatus.phase === 'available') {
    return `<div class="p-update-pill p-update-act" data-act="update-now"><span class="p-update-arrow">↑</span>更新</div>`;
  }
  if (updateStatus.phase === 'downloading') {
    return `<div class="p-update-pill"><span class="p-update-arrow">↑</span>正在下载... ${pct}%</div>`;
  }
  if (updateStatus.phase === 'downloaded') {
    return `<div class="p-update-pill p-update-act" data-act="update-restart"><span class="p-update-arrow">↻</span>点击重启</div>`;
  }
  return '';
}

/**
 * 额度告警文案：只在接近上限时返回内容，平时返回空串。
 *
 * 数据来自 Codex rollout 里 `rate_limits.used_percent`——这是 OpenAI 服务端
 * **下发的**摘要，不是我们算的，权威可靠。
 *
 * 为什么不做常驻、也不放标题栏：
 *  1. 实测 16 天里只有 1 天 5h 窗口破 70%，常驻会变成一块永远不变的装饰，
 *     和「只显示要处理的」这个原则冲突；
 *  2. 标题栏已经放了「N 待确认」，再塞一个 pill 会把 brand 挤到 51px（实测）。
 *     所以它归到页脚 —— 页脚是「负载」区，标题栏是「待办」区。
 */
function quotaAlert(snap: Snapshot): string {
  const q = snap.quota;
  if (!q) return '';

  // 数据过期（>2h 没新采样）就不显示，避免拿旧数据吓人
  if (Date.now() - q.sampledAt > 2 * 60 * 60_000) return '';

  const now = Date.now();
  const p = q.primary;
  // 窗口已过 resets_at 说明额度已重置，旧百分比作废
  if (now >= p.resetsAt * 1000) return '';

  // 5h 窗口阈值 75%，7 天窗口阈值 70%（基数大、恢复慢，更早提醒）
  const s = q.secondary;
  const hot7 = !!s && s.usedPct >= 70 && now < s.resetsAt * 1000;
  const hot5 = p.usedPct >= 75;
  if (!hot5 && !hot7) return '';

  const pick = hot5 ? p : s!;
  const label = hot5 ? '5h' : '7d';
  const tip = `Codex ${label} 额度已用 ${pick.usedPct}% · ${resetIn(pick.resetsAt)}后重置`;
  return `<span class="quota-hot" title="${esc(tip)}">${label} ${pick.usedPct}%</span>`;
}

/** 距重置还有多久：<60m 显示分，否则小时 */
function resetIn(resetsAtSec: number): string {
  const m = Math.max(0, Math.round((resetsAtSec * 1000 - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/**
 * 底栏负载总览：抬头一眼就知道当前负载。
 * 用彩色圆点 + 数字，比纯文字「2 待确认 · 1 进行中 · 5 未读」更快扫读。
 */
function countSummary(c: Snapshot['counts']): string {
  const parts: string[] = [];
  if (c.waiting) parts.push(`<span class="ov"><i class="ov-dot wait"></i>${c.waiting} 等我</span>`);
  if (c.running) parts.push(`<span class="ov"><i class="ov-dot run"></i>${c.running} 在跑</span>`);
  if (c.done) parts.push(`<span class="ov"><i class="ov-dot done"></i>${c.done} 完成</span>`);
  return parts.join('');
}

/* ---------------- 高度同步 ---------------- */

function syncHeight(): void {
  // 用 rAF 等布局稳定后再量，避免读到旧高度
  requestAnimationFrame(() => {
    const el = root.firstElementChild as HTMLElement | null;
    if (!el) return;
    const h = Math.ceil(el.getBoundingClientRect().height);
    if (h > 0) window.pulse.setHeight(h);
  });
}

/* ---------------- 交互 ---------------- */

function handleClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const ackEl = t.closest('[data-ack]') as HTMLElement | null;
  if (ackEl) {
    e.stopPropagation();
    window.pulse.ack(ackEl.dataset.ack!);
    return;
  }

  const act = t.closest('[data-act]') as HTMLElement | null;
  if (act) {
    const a = act.dataset.act;
    if (a === 'collapse') {
      setCollapsed(true);
    } else if (a === 'expand') {
      setCollapsed(false);
    } else if (a === 'menu') {
      window.pulse.mainMenu();
    } else if (a === 'toolbox') {
      window.pulse.toolbox();
    } else if (a === 'toggleDone') {
      doneExpanded = !doneExpanded;
      if (snapshot) paint(snapshot);
    } else if (a === 'update-now') {
      window.pulse.updateNow();
    } else if (a === 'update-restart') {
      window.pulse.updateRestart();
    }
    return;
  }

  // 点击卡片 = 标记已读
  const item = t.closest('.item') as HTMLElement | null;
  if (item?.dataset.key) {
    window.pulse.ack(item.dataset.key);
  }
}

/** 折叠状态必须由渲染层自己立即重绘，否则窗口高度已变、内容还是旧的 */function setCollapsed(v: boolean): void {
  if (collapsed === v) return;
  collapsed = v;
  window.pulse.collapse(v);
  if (snapshot) paint(snapshot);
}

function handleContextMenu(e: MouseEvent): void {
  const item = (e.target as HTMLElement).closest('.item') as HTMLElement | null;
  if (!item?.dataset.key) return;
  e.preventDefault();
  const title = item.querySelector('.title')?.textContent ?? '';
  window.pulse.itemMenu(item.dataset.key, title);
}

/* ---------------- 启动 ---------------- */

function paint(snap: Snapshot): void {
  snapshot = snap;
  root.innerHTML = collapsed ? renderMini(snap) : renderFull(snap);
  syncHeight();
}

/** 收到新快照：整表重绘。额度变化很稀疏，不值得为此维护局部更新。 */
function applyUpdate(snap: Snapshot): void {
  paint(snap);
}

async function boot(): Promise<void> {
  const st = await window.pulse.state();
  collapsed = st.collapsed;

  const snap = await window.pulse.get();
  paint(snap);

  window.pulse.onState((s) => {
    if (collapsed === s.collapsed) return;
    collapsed = s.collapsed;
    if (snapshot) paint(snapshot);
  });

  // 更新事件：映射到胶囊三态（available / downloading / downloaded）
  window.pulse.onUpdateEvent((e: UpdateEvent) => {
    if (e.state === 'available') {
      updateStatus = { phase: 'available', version: e.version, percent: 0 };
    } else if (e.state === 'downloading') {
      updateStatus = { phase: 'downloading', version: e.version, percent: e.percent ?? 0 };
    } else if (e.state === 'downloaded') {
      updateStatus = { phase: 'downloaded', version: e.version, percent: 100 };
    } else {
      // not-available / error：清掉胶囊
      updateStatus = null;
    }
    // 胶囊出现/消失会改变窗口高度，重画一次
    if (snapshot) paint(snapshot);
  });

  document.addEventListener('click', handleClick);
  document.addEventListener('contextmenu', handleContextMenu);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setCollapsed(true);
  });

  // 计时器每秒刷新相对时间 + 停滞/过期文案（只改文本，不重建 DOM）。
  // 用 data-key 匹配而不是下标 —— 完成项折叠时 DOM 里只有未折叠的条目，
  // 下标会错位，key 匹配才可靠。
  timerHandle = window.setInterval(() => {
    if (collapsed || !snapshot) return;
    const byKey = new Map(snapshot.items.map((s) => [s.key, s]));
    root.querySelectorAll('.item').forEach((n) => {
      const key = (n as HTMLElement).dataset.key;
      const s = key ? byKey.get(key) : undefined;
      if (!s) return;
      const t = n.querySelector('.time');
      if (t) t.textContent = relTime(s.stateSince);

      // 停滞文案
      const stallEl = n.querySelector('.stall');
      if (stallEl) {
        const txt = stallText(s);
        if (txt) stallEl.textContent = txt;
        else stallEl.remove(); // 阈值内回落，去掉
      }
      // 过期文案
      const expEl = n.querySelector('.expiry');
      if (expEl) {
        const rem = doneRemaining(s);
        if (rem > 15 * 60 * 1000) expEl.remove();
        else expEl.textContent = `还剩 ${Math.ceil(rem / 60000)} 分钟`;
      }
    });
  }, 1000);

  // 呼吸效果：用低频 JS 切换 class，而不是 CSS 无限动画。
  // 本机 GPU 合成被禁用，CSS 动画会持续软件重绘（实测 14%~43% CPU），
  // 而 700ms 一次的属性变更几乎无开销（实测 0%）。
  breatheTimer = window.setInterval(() => {
    breatheOn = !breatheOn;
    if (collapsed) return;
    root.querySelectorAll('.dot.run, .dot.wait').forEach((d) => {
      d.classList.toggle('pulse-on', breatheOn);
    });
  }, 700);

  // 调试钩子：注入假数据检查各种状态的渲染。
  // 渲染进程只加载本地文件且 CSP 锁死，无外部可达性，保留无安全影响。
  //
  // __pulseFreeze 用于出视觉稿：主进程每 2 秒推一次真实快照，
  // 会立刻覆盖注入的假数据，导致截图截到"半真半假"的状态。
  // 冻结后忽略 onUpdate，注入的内容就能稳定停留。
  let frozen = false;
  (window as any).__pulsePaint = (snap: Snapshot, mini = false) => {
    collapsed = mini;
    paint(snap);
  };
  (window as any).__pulseFreeze = (v = true) => {
    frozen = v;
  };
  (window as any).__pulseSnapshot = () => snapshot;

  // onUpdate 在 freeze 后失效（原注册的回调里判断 frozen）
  window.pulse.onUpdate((s) => {
    if (!frozen) applyUpdate(s);
  });
}

boot();
