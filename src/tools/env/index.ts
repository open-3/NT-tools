// 环境变量速查：展示脱敏后的 process.env，支持筛选
// window.tool 类型见 src/tools/global.d.ts
export {};

const list = document.getElementById('table') as HTMLTableElement;
const filter = document.getElementById('filter') as HTMLInputElement;
const countEl = document.getElementById('count')!;

let all: { key: string; value: string }[] = [];

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function render(): void {
  const q = filter.value.trim().toLowerCase();
  const shown = q ? all.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) : all;

  if (shown.length === 0) {
    list.innerHTML = `<tr><td colspan="2" class="u-empty" style="padding:20px;">无匹配项</td></tr>`;
    countEl.textContent = '0 项';
    return;
  }
  countEl.textContent = `${shown.length} / ${all.length} 个变量`;

  // Windows 系统环境变量对话框风格：两列（变量 | 值），行 hover 高亮
  let html = '<thead><tr>';
  html += '<th style="border:1px solid var(--line);background:var(--panel);padding:5px 10px;position:sticky;top:0;color:var(--t3);text-align:left;font-weight:600;width:40%;">变量</th>';
  html += '<th style="border:1px solid var(--line);background:var(--panel);padding:5px 10px;position:sticky;top:0;color:var(--t3);text-align:left;font-weight:600;">值</th>';
  html += '</tr></thead><tbody>';

  for (const e of shown) {
    const valueHtml = e.value ? esc(e.value) : '<span style="color:var(--t3);">(空)</span>';
    html += `<tr>
      <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t1);font-weight:600;vertical-align:top;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;cursor:pointer;" data-copy="${esc(e.key)}" title="${esc(e.key)}（点击复制）">${esc(e.key)}</td>
      <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t2);vertical-align:top;word-break:break-all;line-height:1.5;cursor:pointer;" data-copy="${esc(e.value)}" title="点击复制值">${valueHtml}</td>
    </tr>`;
  }
  html += '</tbody>';
  list.innerHTML = html;
  list.className = 'env-table';
}

filter.addEventListener('input', render);

document.getElementById('btn-copy')!.addEventListener('click', async () => {
  const allText = all.map((e) => `${e.key}=${e.value}`).join('\n');
  try {
    await navigator.clipboard.writeText(allText);
    const b = document.getElementById('btn-copy')!;
    b.textContent = '已复制 ✓';
    setTimeout(() => (b.textContent = '复制全部'), 1200);
  } catch {
    /* 忽略 */
  }
});

document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!el) return;
  await navigator.clipboard.writeText(el.getAttribute('data-copy')!).catch(() => {});
});

(async () => {
  try {
    const r = await window.tool.envSnapshot();
    all = r.entries;
    render();
  } catch (e: any) {
    list.innerHTML = `<div class="u-empty">加载失败：${esc(e?.message ?? e)}</div>`;
  }
})();
