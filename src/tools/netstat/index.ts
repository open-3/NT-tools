// 端口/进程查看：结构化表格渲染（端口 + 进程名映射）
export {};

const table = document.getElementById('table') as HTMLTableElement;
const filter = document.getElementById('filter') as HTMLInputElement;
const countEl = document.getElementById('count')!;

let tab: 'ports' | 'procs' = 'ports';
let ports: { address: string; port: number; pid: number; process: string }[] = [];
let processes: { pid: number; name: string; mb: number }[] = [];

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function render(): void {
  const q = filter.value.trim().toLowerCase();

  if (tab === 'ports') {
    const rows = ports.filter(
      (p) =>
        !q ||
        p.process.toLowerCase().includes(q) ||
        String(p.port).includes(q) ||
        String(p.pid).includes(q) ||
        p.address.toLowerCase().includes(q),
    );

    let html = `<thead><tr>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">端口</th>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">进程</th>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">PID</th>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">监听地址</th>
    </tr></thead><tbody>`;

    for (const p of rows) {
      html += `<tr>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t1);font-weight:600;">${p.port}</td>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--acc);">${esc(p.process)}</td>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t2);">${p.pid}</td>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t2);">${esc(p.address)}</td>
      </tr>`;
    }
    html += '</tbody>';
    table.innerHTML = html;
    countEl.textContent = `${rows.length} / ${ports.length} 端口`;
  } else {
    const rows = processes.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
    );

    let html = `<thead><tr>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">进程</th>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:left;">PID</th>
      <th style="border:1px solid var(--line);background:var(--panel);padding:6px 10px;position:sticky;top:0;color:var(--t3);text-align:right;">内存 (MB)</th>
    </tr></thead><tbody>`;

    for (const p of rows) {
      html += `<tr>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t1);">${esc(p.name)}</td>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t2);">${p.pid}</td>
        <td style="border:1px solid var(--line);padding:4px 10px;color:var(--t2);text-align:right;font-variant-numeric:tabular-nums;">${p.mb}</td>
      </tr>`;
    }
    html += '</tbody>';
    table.innerHTML = html;
    countEl.textContent = `${rows.length} 进程`;
  }
}

async function load(): Promise<void> {
  table.innerHTML = '<tr><td style="padding:20px;color:var(--t3);">加载中…</td></tr>';
  try {
    const r = await window.tool.netstat();
    if (r.error) {
      table.innerHTML = `<tr><td style="padding:20px;color:#cf222e;">${esc(r.error)}</td></tr>`;
      return;
    }
    ports = r.ports;
    processes = r.processes;
    render();
  } catch (e: any) {
    table.innerHTML = `<tr><td style="padding:20px;color:#cf222e;">失败：${esc(e?.message ?? e)}</td></tr>`;
  }
}

document.getElementById('btn-refresh')!.addEventListener('click', load);
document.getElementById('btn-tab-ports')!.addEventListener('click', () => {
  tab = 'ports';
  render();
});
document.getElementById('btn-tab-procs')!.addEventListener('click', () => {
  tab = 'procs';
  render();
});
filter.addEventListener('input', render);

load();
