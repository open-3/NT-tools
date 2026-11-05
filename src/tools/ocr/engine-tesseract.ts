import { createWorker, type Worker } from 'tesseract.js';
import type { OcrEngine, OcrOptions, OcrResult, OcrLine } from './engine';

/**
 * tesseract.js 引擎实现。
 *
 * 关键决策：**语言包内置，不走 CDN**。
 *
 * 实测结论（同一张真实网页截图）：
 *   - 走 CDN（`@tesseract.js-data/*\/4.0.0_best_int`）识别准确
 *   - 用 `tessdata.projectnaptha.com/4.0.0` 的浮点版喂给同一个 WASM，会大量
 *     形近字误识（`文本`→`割河`、`翻译`→`桓喜译`）—— 版本不匹配
 *
 * 所以内置的就是 `4.0.0_best_int` 这一版（chi_sim 1.64MB + eng 2.82MB ≈ 4.5MB），
 * 精度与 CDN 版完全一致，且离线可用。
 */

/**
 * 语言包目录（相对本工具页面），构建时会被复制到 dist/tools/ocr/lang。
 *
 * 不用 import.meta.url —— 打包目标是 iife，esbuild 会警告；
 * document.baseURI 就是当前 index.html 的 file:// 地址，语义一致且零警告。
 */
const LANG_DIR = new URL('./lang', document.baseURI).href;

export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract';
  readonly label = 'Tesseract.js（内置语言包）';

  private worker: Worker | null = null;
  private loadedLangs = '';

  async isAvailable(): Promise<boolean> {
    // tesseract.js 是纯 WASM，只要 WebAssembly 可用就行
    return typeof WebAssembly === 'object';
  }

  private async ensureWorker(langs: string, onProgress?: OcrOptions['onProgress']): Promise<Worker> {
    if (this.worker && this.loadedLangs === langs) return this.worker;

    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        /* 终止失败忽略 */
      }
      this.worker = null;
    }

    const w = await createWorker(langs, 1, {
      // 指向内置语言包目录（file:// 协议，离线可用）
      langPath: LANG_DIR,
      gzip: true,
      cacheMethod: 'none',
      // worker 与 WASM 核心也用本地的，否则会去 CDN 拉
      workerPath: new URL('./worker.min.js', document.baseURI).href,
      corePath: new URL('./', document.baseURI).href,
      logger: (m: any) => {
        onProgress?.({ status: String(m.status ?? ''), progress: Number(m.progress ?? 0) });
      },
    });

    this.worker = w;
    this.loadedLangs = langs;
    return w;
  }

  async recognize(imageUrl: string, opts: OcrOptions): Promise<OcrResult> {
    const t0 = performance.now();
    const worker = await this.ensureWorker(opts.langs, opts.onProgress);
    const { data } = await worker.recognize(imageUrl);

    const lines: OcrLine[] = [];
    // v7 的行在 blocks[].paragraphs[].lines[] 里
    const blocks = (data as any).blocks ?? [];
    for (const b of blocks) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          const text = String(l.text ?? '').trim();
          if (text) lines.push({ text, confidence: l.confidence });
        }
      }
    }

    // 引擎没给 block 结构时，退化为按 \n 切
    if (lines.length === 0) {
      for (const raw of String(data.text ?? '').split('\n')) {
        const text = raw.trim();
        if (text) lines.push({ text });
      }
    }

    return {
      text: String(data.text ?? '').trim(),
      lines,
      confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
      engine: this.id,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  async dispose(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.worker.terminate();
    } finally {
      this.worker = null;
      this.loadedLangs = '';
    }
  }
}
