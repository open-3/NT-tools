// 表格查看：CSV / TSV / XLSX，支持多 sheet
import * as XLSX from 'xlsx';

export {};

const table = document.getElementById('table') as HTMLTableElement;
const sheetTabs = document.getElementById('sheet-tabs')!;

let workbook: XLSX.WorkBook | null = null;
let activeSheet = '';

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function renderSheet(name: string): void {
  if (!workbook) return;
  activeSheet = name;
  const ws = workbook.Sheets[name];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  // 限制行数避免卡死
  const MAX_ROWS = 500;
  const MAX_COLS = 30;
  const shown = rows.slice(0, MAX_ROWS);
  const colCount = Math.min(MAX_COLS, Math.max(0, ...shown.map((r) => (r as unknown[]).length)));

  let html = '<thead><tr>';
  for (let c = 0; c < colCount; c++) {
    const label = XLSX.utils.encode_col(c);
    html += `<th style="border:1px solid var(--line);background:var(--panel);padding:4px 8px;position:sticky;top:0;color:var(--t3);font-weight:600;">${label}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of shown) {
    html += '<tr>';
    for (let c = 0; c < colCount; c++) {
      const v = (row as unknown[])[c] ?? '';
      html += `<td style="border:1px solid var(--line);padding:3px 8px;color:var(--t1);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;">${esc(String(v))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // sheet 标签
  const names = workbook.SheetNames;
  sheetTabs.innerHTML = names
    .map(
      (n) => `<button class="u-btn" style="${n === activeSheet ? 'background:var(--acc);color:#fff;border-color:var(--acc);' : ''}" data-sheet="${esc(n)}">${esc(n)}</button>`,
    )
    .join('');
  sheetTabs.querySelectorAll('[data-sheet]').forEach((el) => {
    el.addEventListener('click', () => renderSheet((el as HTMLElement).dataset.sheet!));
  });
}

async function load(path: string, data: Uint8Array): Promise<void> {
  try {
    workbook = XLSX.read(data, { type: 'array' });
    renderSheet(workbook.SheetNames[0]!);
  } catch (e: any) {
    table.innerHTML = `<caption class="u-empty">解析失败：${esc(e?.message ?? e)}</caption>`;
  }
}

document.getElementById('btn-open')!.addEventListener('click', async () => {
  const r = await window.tool.readBinaryFile();
  if (!r || !r.data) return;
  await load(r.path, r.data);
});
