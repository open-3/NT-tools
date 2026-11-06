// 随机生成器：UUID / 密码 / token
export {};

const count = document.getElementById('count') as HTMLInputElement;
const uuidOut = document.getElementById('uuid-out')!;
const pwLen = document.getElementById('pw-len') as HTMLInputElement;
const pwSymbols = document.getElementById('pw-symbols') as HTMLInputElement;
const pwOut = document.getElementById('pw-out')!;
const tokenOut = document.getElementById('token-out')!;

function uuid4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function password(len: number, symbols: boolean): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const sym = '!@#$%^&*()-_=+';
  const pool = lower + upper + digits + (symbols ? sym : '');
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += pool[bytes[i]! % pool.length];
  return out;
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function list(title: string, values: string[]): string {
  return values.map((v) => `<div class="u-card-value" style="margin:2px 0;cursor:pointer;" data-copy="${v}" title="点击复制">${v}</div>`).join('');
}

function gen(): void {
  const n = Math.max(1, Math.min(100, Number(count.value) || 1));
  const len = Math.max(4, Math.min(128, Number(pwLen.value) || 16));

  uuidOut.innerHTML = list('', Array.from({ length: n }, () => uuid4()));
  pwOut.innerHTML = list('', Array.from({ length: n }, () => password(len, pwSymbols.checked)));
  tokenOut.innerHTML = list('', Array.from({ length: n }, () => randomHex(32)));
}

document.getElementById('btn-gen')!.addEventListener('click', gen);
[count, pwLen, pwSymbols].forEach((el) => el.addEventListener('change', gen));

// 点击任意结果项复制
document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.dataset.copy!);
    const orig = el.textContent!;
    el.textContent = orig + '  ✓';
    setTimeout(() => (el.textContent = orig), 800);
  } catch {
    /* 忽略 */
  }
});

document.getElementById('btn-copy')!.addEventListener('click', async () => {
  const all = [...document.querySelectorAll('[data-copy]')].map((el) => el.getAttribute('data-copy')).join('\n');
  try {
    await navigator.clipboard.writeText(all);
    const b = document.getElementById('btn-copy')!;
    b.textContent = '已复制 ✓';
    setTimeout(() => (b.textContent = '复制全部'), 1200);
  } catch {
    /* 忽略 */
  }
});

gen();
