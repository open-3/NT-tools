export type SessionState = 'waiting_user' | 'running' | 'done_unread';
export type Confidence = 'exact' | 'inferred';

/**
 * 进行中会话的停滞等级，按「最后活动时间」分档。
 *
 * 为什么要区分：一个 turn 实测能跑 12 小时，「跑很久」和「卡死」从外面看
 * 一模一样（都是"进行中，没动静"）。唯一信号是"多久没有任何活动了"。
 *
 *   ok      < 10 分钟   正常，现状不变
 *   stall   10~60 分钟  值得看一眼（可能只是大活）
 *   stuck   > 60 分钟   很可能卡住/被遗忘，主动标黄
 */
export type StallLevel = 'ok' | 'stall' | 'stuck';

/** 进度信息：让"我该不该再等等"有据可依 */
export interface ProgressInfo {
  /** 轮次/步数编号（从 1 起）。拿不到则 undefined，UI 不显示这项 */
  turn?: number;
  /** 当前轮/步开始的时刻（ms） */
  stepSince?: number;
}

export interface Activity {
  kind: 'tool' | 'thinking' | 'waiting';
  label: string;
  detail?: string;
}

export interface PendingInfo {
  kind: 'approval' | 'question';
  reason?: string;
  since: number;
}

export interface AgentSession {
  /** 稳定主键，形如 `codex:<threadId>` / `dsh:<sessionId>` */
  key: string;
  agent: 'codex' | 'dsh' | string;
  agentLabel: string;
  badge: string;
  title: string;
  project: string;
  state: SessionState;
  /** 进入当前状态的时刻（ms），用于展示「跑了多久」 */
  stateSince: number;
  /** 最后一次真实活动的时刻（ms），用于 ack 比对 */
  lastActivityAt: number;
  confidence: Confidence;
  activity?: Activity;
  pending?: PendingInfo;
  unread?: boolean;
  /**
   * 最终回复的一行摘要（仅 done_unread 有）。
   * 用于「不点开就知道它给了什么」——这是调度场景的核心信息。
   * 取不到时为 undefined，UI 保持原有「已完成 · 未读」文案，不假装。
   */
  resultSummary?: string;
  /** 项目上下文：项目名 + 可选分支，用于区分同名会话 */
  context?: SessionContext;
  /** 该会话改动了多少个文件（仅 Codex 可统计） */
  changedFiles?: number;
  /**
   * 进行中的停滞等级（按最后活动时间算）。只有 running 状态有意义，
   * 由 reconcile 统一算，适配器不用填 —— 见 reconcile.ts 的分档阈值。
   */
  stallLevel?: StallLevel;
  /** 进度（第几轮/本步多久）。Codex 与 DSH 可提供，WorkBuddy 降级为空 */
  progress?: ProgressInfo;
}

export interface SessionContext {
  project: string;
  branch?: string;
}

export interface SourceStatus {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** 额度状态：目前只有 Codex 能从 rollout 的 rate_limits 拿到 */
export interface QuotaState {
  primary: { usedPct: number; windowMin: number; resetsAt: number };
  secondary?: { usedPct: number; windowMin: number; resetsAt: number };
  plan?: string;
  /** 采样时刻，用于判断数据是否过期 */
  sampledAt: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly badge: string;
  detect(): boolean;
  snapshot(): AgentSession[];
}
