/**
 * 空态自动折叠状态机。
 *
 * 规则：
 *  - 列表为空并持续 emptyDelayMs 后，自动收成细条；
 *  - 重新出现内容时立即自动展开；
 *  - 用户手动折叠/展开优先，自动折叠不会覆盖手动选择。
 *
 * 抽成独立模块是为了能脱离 Electron 直接单测。
 */
export interface AutoCollapseDeps {
  isEmpty(): boolean;
  isManuallyCollapsed(): boolean;
  collapse(): void;
  expand(): void;
  setTimer(fn: () => void, ms: number): any;
  clearTimer(handle: any): void;
  now?: () => number;
}

export class AutoCollapse {
  private timer: any = null;
  private autoCollapsed = false;

  constructor(
    private deps: AutoCollapseDeps,
    private emptyDelayMs = 2000,
  ) {}

  /** 每次数据刷新后调用 */
  tick(): void {
    if (this.deps.isEmpty()) {
      if (this.autoCollapsed || this.deps.isManuallyCollapsed()) return;
      if (this.timer !== null) return;
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        if (!this.deps.isEmpty()) return;
        if (this.deps.isManuallyCollapsed()) return;
        this.autoCollapsed = true;
        this.deps.collapse();
      }, this.emptyDelayMs);
      return;
    }

    // 有内容
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.autoCollapsed) {
      this.autoCollapsed = false;
      this.deps.expand();
    }
  }

  /** 用户手动切换后调用：清掉自动状态，让手动选择生效 */
  onManualToggle(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.autoCollapsed = false;
  }

  get isAutoCollapsed(): boolean {
    return this.autoCollapsed;
  }
}
