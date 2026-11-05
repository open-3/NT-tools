import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuotaState } from './adapters/types';

/**
 * Codex 额度状态。
 *
 * Codex 的 rollout 里每条 `token_count` 事件都带一份 `rate_limits`，
 * 这是 **OpenAI 服务端下发的权威数据**，不是我们算的：
 *
 *   {"primary":  {"used_percent":8,  "window_minutes":300,   "resets_at":...},  // 5 小时滚动窗
 *    "secondary":{"used_percent":63, "window_minutes":10080, "resets_at":...}}  // 7 天滚动窗
 *
 * 它比 token 数更值钱：token 数要归一化、有 WorkBuddy 缺口，
 * 而这个直接告诉你「离上限还有多远、多久后清零」。
 *
 * 读取方式：**只读文件尾部 32KB**。rate_limits 挂在每条 token_count 上，
 * 最新的必然在尾部，不需要解析整个文件（实测 <1ms，vs 全量 646ms）。
 */

const HOME = os.homedir();

/**
 * 延迟解析（同 tokens.ts：不能在模块顶层读 env，
 * esbuild 打包 CJS 会把 import 提到最前，导致测试设的 env 失效）。
 */
function codexSessions(): string {
  const dir = process.env.AGENT_PULSE_CODEX_HOME || path.join(HOME, '.codex');
  return path.join(dir, 'sessions');
}

/** 尾部读多少字节。rate_limits 大约每几 KB 出现一次，32KB 足够覆盖最新几条 */
const TAIL_BYTES = 32 * 1024;

/** 只看最近修改的这么多个 rollout，避免遍历全部 */
const MAX_FILES = 3;

function recentRollouts(): string[] {
  const out: { p: string; m: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          out.push({ p, m: fs.statSync(p).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(codexSessions());
  out.sort((a, b) => b.m - a.m);
  return out.slice(0, MAX_FILES).map((x) => x.p);
}

/** 读文件尾部并返回文本（对齐到行边界，避免半行 JSON） */
function readTail(file: string, bytes = TAIL_BYTES): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    // 从第一个换行之后开始，丢掉可能被截断的第一行
    if (size > len) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

interface RawRateLimits {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
  plan_type?: string | null;
}

function parseRateLimits(text: string): { rl: RawRateLimits; ts: number } | null {
  let best: { rl: RawRateLimits; ts: number } | null = null;

  for (const line of text.split('\n')) {
    if (!line || line.indexOf('rate_limits') < 0) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const rl: RawRateLimits | undefined = o?.payload?.rate_limits;
    if (!rl?.primary || typeof rl.primary.used_percent !== 'number') continue;

    const ts = Date.parse(o.timestamp) || 0;
    if (!best || ts > best.ts) best = { rl, ts };
  }
  return best;
}

/**
 * 读取当前额度状态。
 * 返回 undefined 表示拿不到（文件不存在、没有 rate_limits、解析失败）。
 */
export function readQuota(): QuotaState | undefined {
  let files: string[];
  try {
    if (!fs.existsSync(codexSessions())) return undefined;
    files = recentRollouts();
  } catch {
    return undefined;
  }

  let best: { rl: RawRateLimits; ts: number } | null = null;

  for (const f of files) {
    let text: string;
    try {
      text = readTail(f);
    } catch {
      continue;
    }
    const got = parseRateLimits(text);
    if (got && (!best || got.ts > best.ts)) best = got;
  }

  if (!best) return undefined;

  const p = best.rl.primary!;
  const s = best.rl.secondary;

  const q: QuotaState = {
    primary: {
      usedPct: Number(p.used_percent) || 0,
      windowMin: Number(p.window_minutes) || 300,
      resetsAt: Number(p.resets_at) || 0,
    },
    sampledAt: best.ts,
  };

  if (s && typeof s.used_percent === 'number') {
    q.secondary = {
      usedPct: Number(s.used_percent) || 0,
      windowMin: Number(s.window_minutes) || 10080,
      resetsAt: Number(s.resets_at) || 0,
    };
  }
  if (best.rl.plan_type) q.plan = best.rl.plan_type;

  return q;
}
