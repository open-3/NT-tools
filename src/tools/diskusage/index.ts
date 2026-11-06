// 磁盘占用分析：扫描目录，展示每项大小，支持下钻
export {};

const list = document.getElementById('list')!;
const curPath = document.getElementById('cur-path')!;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

async function load(dirPath?: string): Promise<void> {
  list.innerHTML = '<div class="u-empty">扫描中…</div>';
  const r = await window.tool.scanDir(dirPath);
  if (!r) {
    list.innerHTML = '<div class="u-empty">已取消</div>';
    return;
  }
  if (r.error) {
    list.innerHTML = `<div class="u-empty">${esc(r.error)}</div>`;
    return;
  }
  curPath.textContent = r.path;

  // 排序：目录在前，按名；文件按大小降序
  const items = [...r.items];
  const dirs = items.filter((i) => i.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = items.filter((i) => !i.isDir).sort((a, b) => b.size - a.size);

  const renderItem = (i: { name: string; path: string; isDir: boolean; size: number }) => `
    <div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px;align-items:center;">
      <div style="flex:none;width:18px;text-align:center;">${i.isDir ? '📁' : '📄'}</div>
      <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t1);${i.isDir ? 'cursor:pointer;' : ''}" data-dir="${i.isDir ? esc(i.path) : ''}" title="${esc(i.name)}">${esc(i.name)}</div>
      <div style="flex:none;width:90px;text-align:right;color:var(--t2);font-variant-numeric:tabular-nums;">${i.isDir ? '<计算中>' : fmtSize(i.size)}</div>
    </div>`;

  list.innerHTML = [...dirs, ...files].map(renderItem).join('');

  // 目录点击下钻
  list.querySelectorAll('[data-dir]').forEach((el) => {
    if (!el.getAttribute('data-dir')) return;
    el.addEventListener('click', () => {
      void load(el.getAttribute('data-dir')!);
    });
  });
}

document.getElementById('btn-select')!.addEventListener('click', () => void load());
document.getElementById('btn-up')!.addEventListener('click', () => {
  const p = curPath.textContent;
  if (!p) return;
  // 取上级目录
  const parts = p.split(/[\\/]/).filter(Boolean);
  parts.pop();
  const parent = p.startsWith('\\\\') || /^[a-zA-Z]:$/.test(p) ? '' : parts.length ? (p.match(/^([a-zA-Z]:)/)?.[1] + '\\' + parts.join('\\')) : '';
  void load(parent || undefined);
});

void load();
