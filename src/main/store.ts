import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

export interface PersistedState {
  window?: { x?: number; y?: number; width: number };
  alwaysOnTop: boolean;
  collapsed: boolean;
  /** key -> 标记已读的时刻（ms）。lastActivityAt <= ack 即视为已读 */
  acks: Record<string, number>;
  /** key -> 忽略到期时刻（ms）。Number.MAX_SAFE_INTEGER 表示永久 */
  ignored: Record<string, number>;
  autostart: boolean;
}

const DEFAULTS: PersistedState = {
  alwaysOnTop: true,
  collapsed: false,
  acks: {},
  ignored: {},
  autostart: false,
};

export class Store {
  private file: string;
  private data: PersistedState;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const dir = app.getPath('userData');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.file = path.join(dir, 'state.json');
    this.data = this.load();
  }

  private load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        ...DEFAULTS,
        ...parsed,
        acks: parsed.acks ?? {},
        ignored: parsed.ignored ?? {},
      };
    } catch {
      return { ...DEFAULTS, acks: {}, ignored: {} };
    }
  }

  get(): PersistedState {
    return this.data;
  }

  patch(p: Partial<PersistedState>): void {
    Object.assign(this.data, p);
    this.saveSoon();
  }

  ack(key: string, at: number): void {
    this.data.acks[key] = at;
    this.saveSoon();
  }

  ignore(key: string, until: number): void {
    this.data.ignored[key] = until;
    this.saveSoon();
  }

  clearAcks(): void {
    this.data.acks = {};
    this.data.ignored = {};
    this.saveSoon();
  }

  /** 清理已不再出现的 key，避免 state.json 无限增长 */
  pruneKeys(alive: Set<string>): void {
    let changed = false;
    for (const k of Object.keys(this.data.acks)) {
      if (!alive.has(k)) {
        delete this.data.acks[k];
        changed = true;
      }
    }
    for (const k of Object.keys(this.data.ignored)) {
      if (!alive.has(k)) {
        delete this.data.ignored[k];
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  private saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }
}
