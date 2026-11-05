import { AgentSession, SourceStatus, QuotaState, StallLevel } from './adapters/types';
import { Store } from './store';

const ORDER: Record<string, number> = {
  waiting_user: 0,
  running: 1,
  done_unread: 2,
};

/**
 * 停滞分档阈值（毫秒）。
 *
 * 实测一个 Codex turn 中位 7 秒、P90 268 秒、最大 12 小时，「跑很久」和「卡死」
 * 从外面看一样。唯一信号是「多久没有任何活动了」，所以：
 *   < 10 分钟  → ok（正常）
 *   10~60 分钟 → stall（值得看一眼，可能只是大活）
 *   > 60 分钟  → stuck（很可能卡住/被遗忘）
 */
const STALL_STALL_MS = 10 * 60 * 1000;
const STALL_STUCK_MS = 60 * 60 * 1000;

/** 完成未读的可见窗口（与各适配器的 DONE_WINDOW_MS 保持一致） */
export const DONE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 按「最后活动时间」给进行中的会话定停滞等级 */
export function stallLevelOf(s: AgentSession, now: number): StallLevel | undefined {
  if (s.state !== 'running') return undefined;
  const lull = now - s.lastActivityAt;
  if (lull >= STALL_STUCK_MS) return 'stuck';
  if (lull >= STALL_STALL_MS) return 'stall';
  return 'ok';
}

export interface ViewSnapshot {
  items: AgentSession[];
  sources: SourceStatus[];
  counts: { waiting: number; running: number; done: number; total: number };
  /** 是否有任何需要用户注意的项（用于托盘角标/高亮） */
  attention: boolean;
  /** 额度状态（目前只有 Codex 有） */
  quota?: QuotaState;
}

/**
 * 把各适配器的原始会话合并成最终视图：
 *  - 统一列表（不分区块）
 *  - 排序：待确认 → 进行中 → 完成未读，**同级按「等待/运行时长」倒序**
 *  - 应用已读 / 忽略过滤
 *
 * 为什么同级不按 lastActivityAt 排：
 *   调度场景下，最该先处理的是「等得最久的」，而不是「刚有活动的」。
 *   按 lastActivityAt 排会出现「刚启动 3 秒的新会话，把等了 2 小时的待确认挤下去」，
 *   正好和真实优先级相反。
 */
export function reconcile(sessions: AgentSession[], sources: SourceStatus[], store: Store, now = Date.now()): ViewSnapshot {
  const st = store.get();
  const visible: AgentSession[] = [];

  for (const s of sessions) {
    // 已读：活动时间不晚于 ack 时刻 → 不再显示
    const ackedAt = st.acks[s.key];
    if (ackedAt && s.lastActivityAt <= ackedAt) continue;

    // 忽略：未到期则不显示
    const ignoredUntil = st.ignored[s.key];
    if (ignoredUntil && now < ignoredUntil) continue;

    // 停滞分级：只对 running 有意义，统一在这里算
    s.stallLevel = stallLevelOf(s, now);

    visible.push(s);
  }

  visible.sort((a, b) => {
    const oa = ORDER[a.state] ?? 9;
    const ob = ORDER[b.state] ?? 9;
    if (oa !== ob) return oa - ob;
    // 同级：进入当前状态越早 = 等得越久 = 越靠前
    return a.stateSince - b.stateSince;
  });

  const counts = {
    waiting: visible.filter((s) => s.state === 'waiting_user').length,
    running: visible.filter((s) => s.state === 'running').length,
    done: visible.filter((s) => s.state === 'done_unread').length,
    total: visible.length,
  };

  return {
    items: visible,
    sources,
    counts,
    attention: counts.waiting > 0,
  };
}

export function sameSnapshot(a: ViewSnapshot | null, b: ViewSnapshot): boolean {
  if (!a) return false;
  if (a.items.length !== b.items.length) return false;
  if (a.counts.total !== b.counts.total) return false;
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i];
    const y = b.items[i];
    if (x.key !== y.key || x.state !== y.state || x.title !== y.title) return false;
    if (x.activity?.label !== y.activity?.label) return false;
    if (x.pending?.reason !== y.pending?.reason) return false;
    if (x.lastActivityAt !== y.lastActivityAt) return false;
    // 这三个字段是后加的展示信息，漏比会导致「数据到了但界面不刷新」
    // （例如 Codex 的 rollout 晚于 sqlite 落盘，摘要会迟到一步）
    if (x.resultSummary !== y.resultSummary) return false;
    if (x.changedFiles !== y.changedFiles) return false;
    if (x.context?.project !== y.context?.project) return false;
    if (x.context?.branch !== y.context?.branch) return false;
    if (x.confidence !== y.confidence) return false;
    // 停滞分级变了要重绘（跨过 10/60 分钟阈值时变色）
    if (x.stallLevel !== y.stallLevel) return false;
    // 进度（第几轮）变了要重绘
    if (x.progress?.turn !== y.progress?.turn) return false;
  }
  // 额度百分比变了要刷新（告警 pill 的显隐依赖它）
  if (a.quota?.primary.usedPct !== b.quota?.primary.usedPct) return false;
  return true;
}
