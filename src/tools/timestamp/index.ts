// 时间戳换算：秒/毫秒 ↔ 本地时间，自动识别精度
export {};

const ts = document.getElementById('ts') as HTMLInputElement;
const outLocal = document.getElementById('out-local') as HTMLInputElement;
const outUtc = document.getElementById('out-utc') as HTMLInputElement;
const outIso = document.getElementById('out-iso') as HTMLInputElement;
const outAgo = document.getElementById('out-ago') as HTMLInputElement;
const nowSec = document.getElementById('now-sec')!;
const nowMs = document.getElementById('now-ms')!;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;

let currentMs: number | null = null;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmt(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

/** 相对现在的人类可读描述 */
function ago(ms: number): string {
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? '前' : '后';
  const s = Math.floor(abs / 1000);
  if (s < 60) return `${s} 秒${sign}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟${sign}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时${sign}`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d} 天${sign}`;
  return `${(d / 365).toFixed(1)} 年${sign}`;
}

function parseTs(raw: string): number {
  const text = raw.trim();
  if (!text) throw new Error('空');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`「${text}」不是有效时间戳`);
  let n = Number(text);
  // 秒级：< 1e11（约 2286 年前）；毫秒级 >= 1e11
  if (n < 1e11) n *= 1000;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) throw new Error('超出范围');
  return n;
}

function convert(): void {
  try {
    const ms = parseTs(ts.value);
    currentMs = ms;
    const d = new Date(ms);
    outLocal.value = fmt(d);
    outUtc.value = fmt(new Date(ms + d.getTimezoneOffset() * 60000));
    outIso.value = d.toISOString();
    outAgo.value = ago(ms);
    btnCopy.disabled = false;
  } catch (e: any) {
    outLocal.value = '';
    outUtc.value = '';
    outIso.value = '';
    outAgo.value = e?.message || String(e);
    btnCopy.disabled = true;
  }
}

document.getElementById('btn-convert')!.addEventListener('click', convert);
ts.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') convert();
});

document.getElementById('btn-now')!.addEventListener('click', () => {
  ts.value = String(Date.now());
  convert();
});

document.getElementById('btn-s2ms')!.addEventListener('click', () => {
  try {
    const n = parseTs(ts.value);
    // 若输入的是秒，n 已被 *1000；直接回填
    ts.value = String(n);
    convert();
  } catch (e: any) {
    outAgo.value = e?.message || String(e);
  }
});

document.getElementById('btn-ms2s')!.addEventListener('click', () => {
  try {
    const n = parseTs(ts.value);
    ts.value = String(Math.floor(n / 1000));
    convert();
  } catch (e: any) {
    outAgo.value = e?.message || String(e);
  }
});

btnCopy.addEventListener('click', async () => {
  if (currentMs == null) return;
  try {
    await navigator.clipboard.writeText(String(currentMs));
    btnCopy.textContent = '已复制 ✓';
    setTimeout(() => (btnCopy.textContent = '复制当前时间戳'), 1200);
  } catch {
    btnCopy.textContent = '复制失败';
  }
});

// 实时当前时间戳
function tick(): void {
  const d = new Date();
  nowSec.textContent = `秒：${Math.floor(d.getTime() / 1000)}`;
  nowMs.textContent = `毫秒：${d.getTime()}`;
}
tick();
setInterval(tick, 200);
