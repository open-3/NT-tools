// 颜色转换：HEX / RGB / HSL 互转 + 取色器
export {};

const input = document.getElementById('input') as HTMLInputElement;
const picker = document.getElementById('picker') as HTMLInputElement;
const swatch = document.getElementById('swatch')!;
const hexEl = document.getElementById('hex')!;
const rgbEl = document.getElementById('rgb')!;
const hslEl = document.getElementById('hsl')!;

function parseColor(s: string): { r: number; g: number; b: number } | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;

  // #hex / #rrggbb / #rrggbbaa
  const hex = /^#?([0-9a-f]{3,8})$/.exec(t);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length >= 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return { r, g, b };
    }
    return null;
  }

  // rgb(...) / rgba(...)
  const rgb = /^rgba?\(([^)]+)\)/.exec(t);
  if (rgb) {
    const parts = rgb[1].split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
    }
    return null;
  }

  // hsl(...) / hsla(...)
  const hsl = /^hsla?\(([^)]+)\)/.exec(t);
  if (hsl) {
    const parts = hsl[1].split(/[\s,]+/).filter(Boolean).map((v) => parseFloat(v));
    if (parts.length >= 3 && !parts.slice(0, 3).some((n) => Number.isNaN(n))) {
      const h = ((parts[0]! % 360) + 360) % 360 / 360;
      const s = Math.min(100, Math.max(0, parts[1]!)) / 100;
      const l = Math.min(100, Math.max(0, parts[2]!)) / 100;
      return hslToRgb(h, s, l);
    }
    return null;
  }

  return null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  };
}
function hue(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function update(): void {
  const c = parseColor(input.value);
  if (!c) {
    hexEl.textContent = '—';
    rgbEl.textContent = '—';
    hslEl.textContent = '—';
    return;
  }
  const { r, g, b } = c;
  const hex = toHex(r, g, b);
  const { h, s, l } = rgbToHsl(r, g, b);

  swatch.style.background = hex;
  hexEl.textContent = hex;
  hexEl.setAttribute('data-copy', hex);
  rgbEl.textContent = `rgb(${r}, ${g}, ${b})`;
  rgbEl.setAttribute('data-copy', `rgb(${r}, ${g}, ${b})`);
  hslEl.textContent = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  hslEl.setAttribute('data-copy', hslEl.textContent);

  // 同步取色器（不含 alpha）
  picker.value = hex;
}

input.addEventListener('input', update);
picker.addEventListener('input', () => {
  input.value = picker.value;
  update();
});

// 点击复制
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!el) return;
  navigator.clipboard.writeText(el.getAttribute('data-copy')!).catch(() => {});
});

update();
