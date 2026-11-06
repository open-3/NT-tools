// 截图翻译：captureScreen → OCR（复用 ocr 工具的 tesseract 资源）→ 复制/去翻译
import { createWorker } from 'tesseract.js';

export {};

const preview = document.getElementById('preview')!;
const textArea = document.getElementById('text') as HTMLTextAreaElement;
const status = document.getElementById('status')!;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const btnTranslate = document.getElementById('btn-translate') as HTMLButtonElement;

let worker: any = null;
let workerReady = false;

// 复用 ocr 目录下的语言包与 worker（平级目录 ../ocr/）
const OCR_DIR = new URL('../ocr/', document.baseURI).href;

async function ensureWorker(): Promise<any> {
  if (workerReady) return worker;
  status.textContent = '正在初始化识别引擎（首次约 2 秒）…';
  worker = await createWorker('chi_sim+eng', 1, {
    langPath: OCR_DIR + 'lang',
    gzip: true,
    cacheMethod: 'none',
    workerPath: OCR_DIR + 'worker.min.js',
    corePath: OCR_DIR,
    logger: (m: any) => {
      if (m.status === 'recognizing text') {
        status.textContent = `识别中 ${Math.round((m.progress ?? 0) * 100)}%`;
      }
    },
  });
  workerReady = true;
  return worker;
}

document.getElementById('btn-capture')!.addEventListener('click', async () => {
  btnCopy.disabled = true;
  btnTranslate.disabled = true;
  textArea.value = '';
  status.textContent = '正在截图…';

  try {
    const r = await window.tool.captureScreen();
    if (!r.ok || !r.dataURL) {
      status.textContent = `截图失败：${r.error ?? '未知错误'}`;
      return;
    }

    preview.innerHTML = `<img src="${r.dataURL}" style="max-width:100%;max-height:200px;border-radius:6px;" />`;

    const w = await ensureWorker();
    const { data } = await w.recognize(r.dataURL);
    const text = (data.text ?? '').trim();
    textArea.value = text;

    if (text) {
      status.textContent = `识别完成，${data.confidence != null ? '置信度 ' + Math.round(data.confidence) + '%' : ''}`;
      btnCopy.disabled = false;
      btnTranslate.disabled = false;
    } else {
      status.textContent = '未识别到文字';
    }
  } catch (e: any) {
    status.textContent = `失败：${e?.message ?? e}`;
  }
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(textArea.value);
    btnCopy.textContent = '已复制 ✓';
    setTimeout(() => (btnCopy.textContent = '复制文字'), 1200);
  } catch {
    textArea.focus();
    textArea.select();
  }
});

btnTranslate.addEventListener('click', () => {
  const text = textArea.value.trim();
  if (!text) return;
  // 打开百度翻译（把文本编码进 URL，最大程度带上内容）
  const url = `https://fanyi.baidu.com/mtpe-individual/transText?ext_channel=DuSearch#auto/zh/${encodeURIComponent(text)}`;
  window.open(url, '_blank');
});

// 窗口关闭释放 worker
window.addEventListener('beforeunload', () => {
  if (worker) {
    worker.terminate().catch(() => {});
    worker = null;
    workerReady = false;
  }
});
