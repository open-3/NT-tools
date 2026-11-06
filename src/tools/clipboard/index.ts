// 剪贴板历史：轮询 readText，去重记录
export {};

const list = document.getElementById('list')!;
const btnPause = document.getElementById('btn-pause')!;
const btnClear = document.getElementById('btn-clear')!;

let paused = false;
let lastText = '';
let history: { text: string; time: number }[] = [];
const MAX = 50;

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render(): void {
  if (history.length === 0) {
    list.innerHTML = `<div class="u-empty">复制文本后会自动出现在这里</div>`;
    return;
  }
  list.innerHTML = history
    .map(
      (h, i) => `
      <div class="cb-row" data-index="${i}" style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer;align-items:flex-start;">
        <div style="flex:none;width:52px;color:var(--t3);font-size:11px;font-variant-numeric:tabular-nums;">${fmtTime(h.time)}</div>
        <div style="flex:1;font-size:12px;color:var(--t1);word-break:break-all;white-space:pre-wrap;max-height:48px;overflow:hidden;">${esc(h.text)}</div>
      </div>`,
    )
    .join('');
}

async function poll(): Promise<void> {
  if (paused) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text && text !== lastText) {
      lastText = text;
      // 去重：和最近一条相同则跳过
      if (history[0]?.text !== text) {
        history.unshift({ text, time: Date.now() });
        if (history.length > MAX) history.pop();
        render();
      }
    }
  } catch {
    /* 剪贴板无文本或权限不足，忽略 */
  }
}

document.addEventListener('click', async (e) => {
  const row = (e.target as HTMLElement).closest('.cb-row') as HTMLElement | null;
  if (!row) return;
  const idx = Number(row.dataset.index);
  const h = history[idx];
  if (!h) return;
  try {
    await navigator.clipboard.writeText(h.text);
    // 置顶
    history.splice(idx, 1);
    history.unshift(h);
    render();
  } catch {
    /* 忽略 */
  }
});

btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? '继续' : '暂停';
});

btnClear.addEventListener('click', () => {
  history = [];
  render();
});

render();
setInterval(poll, 800);
poll();
