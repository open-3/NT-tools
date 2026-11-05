/**
 * OCR 引擎抽象层。
 *
 * 设计目的：**识别引擎必须可替换**。UI 只依赖 `OcrEngine` 接口，
 * 不关心背后是 tesseract.js、Windows OCR 还是在线 API。
 *
 * 为什么值得抽这一层：实测不同引擎的精度差异很大（同一张图，tesseract 能
 * 正确识别 `自动检测 / 中文(简体) / AI大模型翻译`，而 Windows 自带 OCR 会把
 * 整页拍成一行、英文词错成 `Baid"`、`Al`）。将来若换更准的引擎，
 * 只需实现这个接口并注册，UI 与交互零改动。
 */

/** 识别结果里的一行 */
export interface OcrLine {
  text: string;
  /** 该行置信度 0~100，引擎给不出时为 undefined */
  confidence?: number;
}

export interface OcrResult {
  /** 纯文本（保留换行） */
  text: string;
  /** 逐行结果，便于做行级校对 */
  lines: OcrLine[];
  /** 整张图的平均置信度 0~100 */
  confidence?: number;
  /** 实际使用的引擎 id，便于排查"换引擎后效果差异" */
  engine: string;
  /** 识别耗时（ms） */
  durationMs: number;
}

export interface OcrOptions {
  /** 语言，如 'chi_sim+eng'。引擎不支持时自行降级 */
  langs: string;
  /** 传给引擎的进度回调（0~1 或带阶段描述） */
  onProgress?: (p: { status: string; progress: number }) => void;
}

export interface OcrEngine {
  /** 稳定标识，用于展示和日志 */
  readonly id: string;
  /** 显示名 */
  readonly label: string;
  /** 能力探测：该引擎在当前环境是否可用 */
  isAvailable(): Promise<boolean>;
  /** 识别一张图片（入参是可直接喂给 canvas/img 的 URL 或 dataURL） */
  recognize(imageUrl: string, opts: OcrOptions): Promise<OcrResult>;
  /** 释放资源（如 worker） */
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 引擎注册表                                                          */
/* ------------------------------------------------------------------ */

const engines = new Map<string, () => OcrEngine>();
let activeId: string | null = null;

/** 注册一个引擎（惰性实例化，避免启动时就加载大资源） */
export function registerEngine(id: string, factory: () => OcrEngine): void {
  engines.set(id, factory);
}

/** 设定当前使用的引擎 */
export function setActiveEngine(id: string): void {
  if (!engines.has(id)) throw new Error(`未注册的 OCR 引擎：${id}`);
  activeId = id;
}

/** 列出已注册引擎 */
export function listEngines(): string[] {
  return [...engines.keys()];
}

/**
 * 取当前引擎实例。同一时间只保留一个，切换时先释放旧的，
 * 因为 tesseract 的 worker 很重（WASM + 语言模型）。
 */
let current: OcrEngine | null = null;
let currentId: string | null = null;

export async function getEngine(id?: string): Promise<OcrEngine> {
  const want = id ?? activeId ?? [...engines.keys()][0];
  if (!want) throw new Error('没有任何可用的 OCR 引擎');
  if (current && currentId === want) return current;

  // 切换引擎：先释放旧的
  if (current) {
    try {
      await current.dispose();
    } catch {
      /* 释放失败不影响新引擎 */
    }
    current = null;
    currentId = null;
  }

  const factory = engines.get(want);
  if (!factory) throw new Error(`未注册的 OCR 引擎：${want}`);
  const inst = factory();
  const ok = await inst.isAvailable();
  if (!ok) throw new Error(`OCR 引擎不可用：${want}`);
  current = inst;
  currentId = want;
  return inst;
}

/** 释放当前引擎（窗口关闭时调用） */
export async function disposeEngine(): Promise<void> {
  if (!current) return;
  try {
    await current.dispose();
  } finally {
    current = null;
    currentId = null;
  }
}
