// 图片压缩：读二进制 → canvas 缩放 → 重新编码
export {};

const status = document.getElementById('status')!;
const preview = document.getElementById('preview')!;
const quality = document.getElementById('quality') as HTMLInputElement;
const scale = document.getElementById('scale') as HTMLInputElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;

let originalBlob: Blob | null = null;
let originalName = '';
let compressedDataURL: string | null = null;

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function compress(): Promise<void> {
  if (!originalBlob) return;
  const q = Math.max(10, Math.min(100, Number(quality.value) || 70)) / 100;
  const s = Math.max(10, Math.min(100, Number(scale.value) || 100)) / 100;

  const bitmap = await createImageBitmap(originalBlob);
  const w = Math.round(bitmap.width * s);
  const h = Math.round(bitmap.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  compressedDataURL = canvas.toDataURL('image/jpeg', q);

  const originalSize = originalBlob.size;
  // 估算压缩后大小（dataURL 长度 × 0.75 近似 base64 → 二进制）
  const compressedSize = Math.round((compressedDataURL.length - compressedDataURL.indexOf(',') - 1) * 0.75);

  const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(0);
  status.innerHTML = `
    <div style="font-size:12px;color:var(--t2);">
      原图 ${bitmap ? '' : ''}${originalSize > 0 ? fmtSize(originalSize) : ''} → ${fmtSize(compressedSize)}
    </div>
    <div style="font-size:20px;font-weight:600;color:${Number(ratio) > 0 ? '#1a7f37' : '#cf222e'};margin:4px 0;">
      ${ratio}%
    </div>
    <div style="font-size:11px;color:var(--t3);">${w}×${h} px（原 ${bitmap ? '' : ''}）</div>
  `;
  preview.innerHTML = `<img src="${compressedDataURL}" style="max-width:100%;max-height:300px;border-radius:6px;" />`;
  btnDownload.disabled = false;
}

document.getElementById('btn-open')!.addEventListener('click', async () => {
  const r = await window.tool.readBinaryFile();
  if (!r || !r.data) return;
  originalName = r.name || 'image.jpg';
  originalBlob = new Blob([r.data as BlobPart], { type: 'image/jpeg' });
  preview.innerHTML = '<div class="u-empty">已载入，正在压缩…</div>';
  await compress();
});

quality.addEventListener('change', compress);
scale.addEventListener('change', compress);

btnDownload.addEventListener('click', () => {
  if (!compressedDataURL) return;
  const a = document.createElement('a');
  const base = originalName.replace(/\.[^.]+$/, '');
  a.href = compressedDataURL;
  a.download = `${base}-compressed.jpg`;
  a.click();
});
