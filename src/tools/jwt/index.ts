// JWT 解析：只解码 header/payload，不做签名验证（本地查看用途）
export {};

const jwtInput = document.getElementById('jwt') as HTMLTextAreaElement;
const headerEl = document.getElementById('header') as HTMLPreElement;
const payloadEl = document.getElementById('payload') as HTMLPreElement;
const expEl = document.getElementById('exp')!;
const expLabel = document.getElementById('exp-label')!;
const btnExp = document.getElementById('btn-exp') as HTMLButtonElement;

function b64UrlDecode(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

let expTime: number | null = null;

function parse(): void {
  const raw = jwtInput.value.trim();
  if (!raw) {
    headerEl.textContent = '';
    payloadEl.textContent = '';
    expEl.innerHTML = '';
    btnExp.disabled = true;
    expTime = null;
    return;
  }

  const parts = raw.split('.');
  if (parts.length < 2) {
    headerEl.textContent = '无效的 JWT（应包含 header.payload.signature 三段）';
    payloadEl.textContent = '';
    expEl.innerHTML = '';
    btnExp.disabled = true;
    expTime = null;
    return;
  }

  try {
    headerEl.textContent = pretty(b64UrlDecode(parts[0]!));
    const payload = pretty(b64UrlDecode(parts[1]!));
    payloadEl.textContent = payload;

    // 提取 exp
    const obj = JSON.parse(b64UrlDecode(parts[1]!));
    if (typeof obj.exp === 'number') {
      expTime = obj.exp;
      btnExp.disabled = false;
      checkExp();
    } else {
      expTime = null;
      btnExp.disabled = true;
      expEl.innerHTML = '<span style="font-size:12px;color:var(--t3);">无 exp 字段</span>';
      expLabel.textContent = '过期状态（无 exp）';
    }
  } catch (e: any) {
    headerEl.textContent = `解码失败：${e?.message ?? e}`;
    payloadEl.textContent = '';
    expEl.innerHTML = '';
    btnExp.disabled = true;
    expTime = null;
  }
}

function checkExp(): void {
  if (expTime == null) return;
  const d = new Date(expTime * 1000);
  const now = Date.now();
  const remaining = expTime * 1000 - now;
  const isExpired = remaining < 0;
  const abs = Math.abs(remaining);
  const s = Math.floor(abs / 1000);
  const human = s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分钟` : s < 86400 ? `${Math.floor(s / 3600)} 小时` : `${Math.floor(s / 86400)} 天`;

  expLabel.textContent = '过期状态';
  expEl.innerHTML = `
    <div style="margin-bottom:4px;color:${isExpired ? '#cf222e' : '#1a7f37'};font-weight:600;">
      ${isExpired ? '已过期' : '有效'}
    </div>
    <div class="u-card-value">exp = ${expTime}（${d.toLocaleString()}）</div>
    <div class="u-card-value" style="color:var(--t3);">
      ${isExpired ? `过期 ${human}` : `剩余 ${human}`}
    </div>`;
}

jwtInput.addEventListener('input', parse);
btnExp.addEventListener('click', checkExp);

parse();
