// 终端小抄：分类命令速查 + 搜索 + 点击复制
import { CHEATS, totalCount } from './commands';

export {};

const tabs = document.getElementById('tabs')!;
const filter = document.getElementById('filter') as HTMLInputElement;
const countEl = document.getElementById('count')!;
const list = document.getElementById('list')!;

let activeCategory = 'all';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** 求筛选后的条目（跨分类，用于「全部」tab 或搜索状态） */
function filteredItems(): { category: string; categoryLabel: string; cmd: string; desc: string }[] {
  const q = filter.value.trim().toLowerCase();
  const out: { category: string; categoryLabel: string; cmd: string; desc: string }[] = [];

  for (const cat of CHEATS) {
    if (activeCategory !== 'all' && cat.id !== activeCategory) continue;
    for (const item of cat.items) {
      if (!q || item.cmd.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)) {
        out.push({ category: cat.id, categoryLabel: cat.label, cmd: item.cmd, desc: item.desc });
      }
    }
  }
  return out;
}

function renderTabs(): void {
  const all = [{ id: 'all', label: '全部' }, ...CHEATS];
  tabs.innerHTML = all
    .map((c) => {
      const active = c.id === activeCategory;
      return `<button class="u-btn" data-cat="${esc(c.id)}" style="${active ? 'background:var(--acc);color:#fff;border-color:var(--acc);' : ''}">${esc(c.label)}</button>`;
    })
    .join('');
  tabs.querySelectorAll('[data-cat]').forEach((el) => {
    el.addEventListener('click', () => {
      activeCategory = (el as HTMLElement).dataset.cat!;
      renderTabs();
      renderList();
    });
  });
}

function renderList(): void {
  const items = filteredItems();
  countEl.textContent = `${items.length} 条命令`;

  if (items.length === 0) {
    list.innerHTML = `<div class="u-empty">无匹配命令</div>`;
    return;
  }

  // 按分类分组显示（「全部」时保留分类小标题）
  const needGroup = activeCategory === 'all';
  const groups: { label: string; items: typeof items }[] = [];
  if (needGroup) {
    for (const cat of CHEATS) {
      const subset = items.filter((i) => i.category === cat.id);
      if (subset.length) groups.push({ label: cat.label, items: subset });
    }
  } else {
    const cat = CHEATS.find((c) => c.id === activeCategory);
    groups.push({ label: cat?.label ?? '', items });
  }

  list.innerHTML = groups
    .map((g) => {
      const catTitle = needGroup ? `<div style="font-size:11px;color:var(--t3);font-weight:600;letter-spacing:0.5px;padding:8px 2px 4px;border-bottom:1px solid var(--line);">${esc(g.label)}</div>` : '';
      const rows = g.items
        .map(
          (it) => `
        <div style="display:flex;gap:10px;padding:6px 2px;border-bottom:1px solid var(--line);align-items:flex-start;">
          <div style="flex:0 0 auto;min-width:0;max-width:60%;">
            <code style="font-family:var(--mono);font-size:12px;color:var(--t1);word-break:break-all;cursor:pointer;" data-cmd="${esc(it.cmd)}" title="点击复制命令">${esc(it.cmd)}</code>
          </div>
          <div style="flex:1;font-size:12px;color:var(--t2);line-height:1.5;">${esc(it.desc)}</div>
        </div>`,
        )
        .join('');
      return catTitle + rows;
    })
    .join('');
}

filter.addEventListener('input', renderList);

// 点击命令复制
document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('[data-cmd]') as HTMLElement | null;
  if (!el) return;
  const cmd = el.getAttribute('data-cmd')!;
  try {
    await navigator.clipboard.writeText(cmd);
    const orig = el.textContent!;
    el.textContent = orig + '  ✓';
    setTimeout(() => (el.textContent = orig), 900);
  } catch {
    el.textContent = '复制失败';
  }
});

renderTabs();
renderList();
