import { registerEngine, getEngine, disposeEngine } from './engine';
import { TesseractEngine } from './engine-tesseract';

// 注册引擎（将来换引擎只需换这一行 / 再加一个 registerEngine）
registerEngine('tesseract', () => new TesseractEngine());

export {};

const fileInput = document.getElementById('file') as HTMLInputElement;
const preview = document.getElementById('preview') as HTMLImageElement;
const empty = document.getElementById('empty')!;
const drop = document.getElementById('drop')!;
const out = document.getElementById('out') as HTMLTextAreaElement;
const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;
const btnRun = document.getElementById('btn-run') as HTMLButtonElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;

/** 当前待识别的图片（dataURL / blob URL） */
let currentUrl: string | null = null;
/** 上一次的 blob URL，切换图片时释放，避免泄漏 */
let lastBlobUrl: string | null = null;

function setStatus(msg: string, isErr = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isErr);
}

function setImage(url: string, revoke = false): void {
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = null;
  }
  if (revoke) lastBlobUrl = url;

  currentUrl = url;
  preview.src = url;
  preview.hidden = false;
  empty.hidden = true;
  btnRun.disabled = false;
  btnCopy.disabled = true;
  metaEl.textContent = '';
  out.value = '';
  setStatus('已载入图片，点「识别」开始');
}

function clearImage(): void {
  currentUrl = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  empty.hidden = false;
  btnRun.disabled = true;
  btnCopy.disabled = true;
}

/* ---------------- 载入图片的三种方式 ---------------- */

function loadFile(file: File): void {
  if (!file.type.startsWith('image/')) {
    setStatus('这不是图片文件', true);
    return;
  }
  const url = URL.createObjectURL(file);
  setImage(url, true);
}

// 1. 选择文件
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = ''; // 允许重复选同一个文件
});

// 2. 拖拽
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// 3. 粘贴（Ctrl+V）
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();
        loadFile(f);
        return;
      }
    }
  }
});

// 「粘贴图片」按钮：尝试读剪贴板（需要用户手势，失败给出指引）
document.getElementById('btn-paste')!.addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        const url = URL.createObjectURL(blob);
        setImage(url, true);
        return;
      }
    }
    setStatus('剪贴板里没有图片，可直接按 Ctrl+V', true);
  } catch {
    setStatus('无法读取剪贴板，请直接按 Ctrl+V 粘贴', true);
  }
});

/* ---------------- 识别 ---------------- */

btnRun.addEventListener('click', async () => {
  if (!currentUrl) return;

  btnRun.disabled = true;
  btnCopy.disabled = true;
  out.value = '';
  setStatus('正在初始化识别引擎（首次约 2 秒）…');

  try {
    const engine = await getEngine();
    const result = await engine.recognize(currentUrl, {
      langs: 'chi_sim+eng',
      onProgress: (p) => {
        if (p.status) setStatus(`${p.status} ${Math.round((p.progress ?? 0) * 100)}%`);
      },
    });

    out.value = result.text || '（没有识别到文字）';
    btnCopy.disabled = !result.text;

    const conf = result.confidence != null ? ` · 置信度 ${Math.round(result.confidence)}%` : '';
    metaEl.textContent = `${result.lines.length} 行 · ${result.durationMs}ms${conf}`;
    setStatus(result.text ? `识别完成（引擎：${result.engine}）` : '没有识别到文字');
  } catch (e: any) {
    setStatus(`识别失败：${e?.message ?? e}`, true);
  } finally {
    btnRun.disabled = !currentUrl;
  }
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus('已复制到剪贴板');
  } catch {
    // 退路：选中让用户手动复制
    out.focus();
    out.select();
    setStatus('已选中，按 Ctrl+C 复制', true);
  }
});

// 窗口关闭时释放引擎（worker 很重，不释放会占内存）
window.addEventListener('beforeunload', () => {
  void disposeEngine();
});

setStatus('就绪');
