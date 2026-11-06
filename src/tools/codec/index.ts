// 编码转换：Unicode / URL / Base64 / Hex 双向
export {};

const mode = document.getElementById('mode') as HTMLSelectElement;
const inp = document.getElementById('inp') as HTMLTextAreaElement;
const out = document.getElementById('out') as HTMLTextAreaElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;

function b64Encode(s: string): string {
  // 支持中文：用 UTF-8 字节
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64Decode(s: string): string {
  const bin = atob(s.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function run(): void {
  const m = mode.value;
  const text = inp.value;
  try {
    let result = '';
    switch (m) {
      case 'uni2cn':
        result = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        break;
      case 'cn2uni':
        result = text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
        break;
      case 'urlenc':
        result = encodeURIComponent(text);
        break;
      case 'urldec':
        result = decodeURIComponent(text);
        break;
      case 'b64enc':
        result = b64Encode(text);
        break;
      case 'b64dec':
        result = b64Decode(text);
        break;
      case 'hexenc':
        result = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        break;
      case 'hexdec': {
        const bytes = text.trim().replace(/\s+/g, '').match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
        result = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        break;
      }
      default:
        result = '';
    }
    out.value = result;
    btnCopy.disabled = !result;
  } catch (e: any) {
    out.value = `转换失败：${e?.message ?? e}`;
    btnCopy.disabled = true;
  }
}

document.getElementById('btn-run')!.addEventListener('click', run);
mode.addEventListener('change', run);
inp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) run();
});

document.getElementById('btn-swap')!.addEventListener('click', () => {
  inp.value = out.value;
  out.value = '';
  run();
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    btnCopy.textContent = '已复制 ✓';
    setTimeout(() => (btnCopy.textContent = '复制结果'), 1200);
  } catch {
    out.focus();
    out.select();
  }
});
