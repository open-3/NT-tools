// 二维码：生成（qrcode）+ 识别（jsqr）
import * as QRCode from 'qrcode';
import jsQR from 'jsqr';

export {};

const genText = document.getElementById('gen-text') as HTMLTextAreaElement;
const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
const btnSave = document.getElementById('btn-save-qr') as HTMLButtonElement;
const decodeResult = document.getElementById('decode-result')!;

let currentDataURL: string | null = null;

// 生成（防抖）
let genTimer: number | undefined;
genText.addEventListener('input', () => {
  window.clearTimeout(genTimer);
  genTimer = window.setTimeout(async () => {
    const text = genText.value.trim();
    if (!text) {
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      btnSave.disabled = true;
      currentDataURL = null;
      return;
    }
    try {
      await QRCode.toCanvas(canvas, text, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
      currentDataURL = canvas.toDataURL('image/png');
      btnSave.disabled = false;
    } catch (e: any) {
      btnSave.disabled = true;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, 250);
});

btnSave.addEventListener('click', () => {
  if (!currentDataURL) return;
  const a = document.createElement('a');
  a.href = currentDataURL;
  a.download = 'qrcode.png';
  a.click();
});

document.getElementById('btn-clear-gen')!.addEventListener('click', () => {
  genText.value = '';
  genText.dispatchEvent(new Event('input'));
});

// 识别
document.getElementById('btn-decode')!.addEventListener('click', async () => {
  const r = await window.tool.readBinaryFile();
  if (!r || !r.data) return;
  try {
    const blob = new Blob([r.data as BlobPart]);
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, c.width, c.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    bitmap.close();

    if (result) {
      decodeResult.innerHTML = `<div class="u-card-value" style="word-break:break-all;" data-copy="${result.data.replace(/"/g, '&quot;')}">${result.data.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]!)}</div>`;
    } else {
      decodeResult.innerHTML = `<span class="u-empty" style="color:#cf222e;">未识别到二维码</span>`;
    }
  } catch (e: any) {
    decodeResult.innerHTML = `<span class="u-empty" style="color:#cf222e;">识别失败：${e?.message ?? e}</span>`;
  }
});
