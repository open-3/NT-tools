/**
 * 从 agent 的最终回复里提取一行可读摘要。
 *
 * 为什么需要专门的提取逻辑，而不是简单截断：
 *   362px 的卡片只能放约 40 个字，而实测回复中位数 156 字、P90 674 字。
 *   直接截断会得到「已修复。根因是无类型 Port/Property 的自…」这种无意义片段。
 *
 * 而「取第一句」更糟：实测「已修复。根因是…」取第一句只剩「已修复。」4 个字，
 * 信息量为零。所以必须剥掉这类空话前缀再取。
 *
 * 本规则在 198 条真实 Codex final_answer 上验证：中位 13 字，最长 41 字，超限 0 条。
 */

/** 卡片单行大约能放这么多字（12.8px 字体、362px 宽、去掉徽标与时间） */
export const SUMMARY_LIMIT = 40;

/** 「已修复。」「已完成。」这类没有信息量的开场白 */
const EMPTY_PREFIX = /^(已修复|已完成|已修改|已更新|已处理|已完成修改|已搞定|好了|完成|修复完成)[。.！!，,：:\s]*/;

/** 摘要提取：把任意长度的最终回复压成一行 */
export function summarize(raw: string | null | undefined, limit = SUMMARY_LIMIT): string {
  if (!raw) return '';
  let t = String(raw).replace(/\r?\n/g, ' ').trim();
  if (!t) return '';

  // 1) 结构化输出（如 guardian 审查返回的 JSON）→ 提取关键字段
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      for (const k of ['outcome', 'summary', 'result', 'rationale', 'message']) {
        const v = obj?.[k];
        if (typeof v === 'string' && v.trim()) return clamp(v.trim(), limit);
      }
      return '(结构化输出)';
    } catch {
      return '(结构化输出)';
    }
  }

  // 2) 去掉 markdown 装饰
  t = t.replace(/^[#>\-*\s]+/, '');
  t = t.replace(/\*\*|__|`/g, '');

  // 3) 剥掉「已修复」这类空话前缀；若剥完为空则保留原句
  const stripped = t.replace(EMPTY_PREFIX, '').trim();
  if (stripped) t = stripped;

  // 4) 按句末标点切句，累积到足够长度为止（避免只剩几个字）
  const parts = t.split(/(?<=[。！？!?])/).filter(Boolean);
  let out = '';
  for (const p of parts) {
    out += p;
    if (out.length >= 15) break;
  }
  if (!out) out = t;

  return clamp(out, limit);
}

/** 超长时优先在逗号处断开，其次硬截断 */
function clamp(s: string, limit: number): string {
  s = s.trim();
  if (s.length <= limit) return s;

  // 在 limit+8 范围内找最后一个逗号/分号，避免断在半句
  const head = s.slice(0, limit + 8);
  const m = head.match(/[，,；;、]/g);
  if (m) {
    const idx = head.lastIndexOf(m[m.length - 1]);
    if (idx >= limit * 0.5) return s.slice(0, idx + 1);
  }
  return s.slice(0, limit) + '…';
}

/**
 * 从 DSH 的 assistant/message 事件里取纯文本。
 *
 * 关键：content 数组里同时有 reasoning 和 text 两种块，
 * 必须只取 text —— 否则会把思考过程当成结果显示出来。
 */
export function extractDshText(message: any): string {
  if (!message) return '';
  const content = message.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text);
    if (texts.length) return texts.join(' ').trim();
  }
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}
