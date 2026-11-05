/**
 * 项目名清洗。
 *
 * 三个工具的项目名都取自 cwd 末段，但格式不一致：
 *   Codex    —— "\\?\D:\work\acme\acme-service-backend-local"（Windows 长路径前缀）
 *   DSH      —— "D:\work\app"
 *   WorkBuddy —— 可能带时间戳目录，如 "C:\Users\me\WorkBuddy AI\2026-10-24-00-50-30"
 *
 * 最后这种显示出来毫无意义（用户看到的是 "2026-10-24-00-50-30"），
 * 需要兜底：识别时间戳/临时目录名，改用上层目录。
 */

/** 时间戳式目录名：2026-10-24-00-50-30 / 20261024 / 2026-10-24 */
const TIMESTAMP_DIR =
  /^(\d{4}[-_]?\d{2}[-_]?\d{2}([-_T ]?\d{2}[-_:]?\d{2}([-_:]?\d{2})?)?)$/;

/** 明显无意义的目录名 */
const MEANINGLESS = new Set([
  'new-chat',
  'default-workspace',
  'tmp',
  'temp',
  'test',
  'untitled',
  'workspace',
]);

/** 从路径取末段 */
function lastSeg(p: string): string {
  const clean = p.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const seg = clean.split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

/** 取倒数第 n 段（n 从 1 开始） */
function segAt(p: string, n: number): string {
  const clean = p.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const seg = clean.split(/[\\/]/).filter(Boolean);
  const idx = seg.length - n;
  return idx >= 0 && idx < seg.length ? seg[idx] : '';
}

/**
 * 生成可读的项目名。
 * 时间戳目录会退到上层；上层也是无意义名字时原样返回末段（总比空好）。
 */
export function projectName(cwd: string | null | undefined): string {
  if (!cwd) return '';

  let name = lastSeg(cwd);
  if (!name) return '';

  // 时间戳目录 → 退一层
  if (TIMESTAMP_DIR.test(name)) {
    const parent = segAt(cwd, 2);
    if (parent && !TIMESTAMP_DIR.test(parent)) name = parent;
  }

  return name;
}

/**
 * 判断项目名是否值得显示。
 * 「test」「new-chat」这类名字区分度太低，显示反而增加噪声。
 */
export function isMeaningfulProject(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (MEANINGLESS.has(lower)) return false;
  if (TIMESTAMP_DIR.test(name)) return false;
  // 纯数字/纯符号的目录名也没意义
  if (!/[a-zA-Z\u4e00-\u9fa5]/.test(name)) return false;
  return true;
}

/**
 * 组装项目上下文：项目名 + 可选分支。
 *
 * 项目名会做**压缩**：362px 的卡片里，项目名过长会把标题挤没
 * （实测 acme-service-backend-local 占 96px，标题只剩 130px）。
 * 压缩策略：保留首尾、中间省略，如 "acme-service…backend-local"。
 */
export function buildContext(
  cwd: string | null | undefined,
  branch?: string | null,
): { project: string; branch?: string } | undefined {
  const raw = projectName(cwd);
  if (!isMeaningfulProject(raw)) return undefined;

  const project = shortenProject(raw);

  let b = (branch ?? '').trim();
  if (b) {
    // 去掉 refs/heads/ 前缀，取最后一段
    b = b.replace(/^refs\/heads\//, '');
    const seg = b.split('/').filter(Boolean);
    if (seg.length > 1) b = seg[seg.length - 1];
    // 主分支不显示（信息量低，所有项目都有）
    if (/^(main|master|develop|dev|trunk)$/i.test(b)) b = '';
    if (b.length > 20) b = b.slice(0, 20) + '…';
  }

  return b ? { project, branch: b } : { project };
}

/** 项目名最长显示多少个字符（再长就压缩，给标题留空间） */
const PROJECT_MAX = 20;

/**
 * 压缩长项目名：保留首尾，中间用省略号。
 * acme-service-backend-local → acme-service…backend-local
 */
export function shortenProject(name: string, max = PROJECT_MAX): string {
  if (name.length <= max) return name;

  // 优先按 - _ . 切段，取「首段 + … + 末段」
  const parts = name.split(/[-_.]/).filter(Boolean);
  if (parts.length >= 2) {
    const head = parts[0];
    const tail = parts[parts.length - 1];
    const combined = `${head}…${tail}`;
    if (combined.length <= max) return combined;
  }

  // 否则头尾各取一半
  const half = Math.floor((max - 1) / 2);
  return name.slice(0, half) + '…' + name.slice(name.length - (max - 1 - half));
}
