// JSON 格式化小工具。
//
// 无框架、无依赖。纯 DOM + JSON.parse/stringify。
// 布局：一行号栏（含折叠箭头）+ 文本编辑区，折叠行为类似 VS Code。
//
// 折叠的关键约束：折叠只是**视图**，不能污染内容。
//   - 真实内容始终保存在 fullText 里
//   - 折叠时 textarea 置为只读，显示的是「去掉被折叠行」的文本
//   - 保存 / 格式化 / 打开一律用 fullText，绝不写回折叠后的文本

// 空导出让本文件成为模块（`declare global` 只能出现在模块里）
export {};

interface ToolApi {
  openFile(): Promise<{ path: string; content: string | null; error?: string } | null>;
  saveFile(filePath: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  saveFileAs(defaultName: string, content: string): Promise<{ ok: boolean; path?: string; error?: string } | null>;
}

declare global {
  interface Window {
    tool: ToolApi;
  }
}

const app = document.getElementById('app')!;

/** 当前打开的文件路径；null 表示未关联文件 */
let currentPath: string | null = null;

/** 是否有未保存的修改 */
let dirty = false;

/** 真实内容（折叠不影响它） */
let fullText = '';

/** 已折叠块的起始行号（0 基，指原文行号） */
const folds = new Set<number>();

/** 每个可折叠块的起止行号：startLine -> endLine（0 基，含括号行） */
let blocks = new Map<number, number>();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function formatError(e: unknown): string {
  if (e instanceof SyntaxError) {
    const m = /position (\d+)/.exec(e.message);
    if (m) return `JSON 语法错误（位置 ${m[1]}）：${e.message.replace(/ in JSON at position \d+/, '')}`;
    return `JSON 语法错误：${e.message}`;
  }
  return String(e);
}

function tryFormat(text: string): { ok: true; output: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, output: '' };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, output: JSON.stringify(parsed, null, 2) };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

/* ---------------- 折叠区域计算 ---------------- */

/**
 * 扫描文本，找出每个 `{` / `[` 所在的起始行与匹配的结束行。
 * 必须跳过字符串内部，否则 `"a{b"` 这种会把括号算错。
 * 只保留跨行的块（起止同行没有可折叠内容）。
 */
function computeBlocks(text: string): Map<number, number> {
  const out = new Map<number, number>();
  const stack: { line: number; ch: string }[] = [];
  let inStr = false;
  let escNext = false;
  let line = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      line++;
      continue;
    }
    if (inStr) {
      if (escNext) escNext = false;
      else if (c === '\\') escNext = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') stack.push({ line, ch: c });
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (open && line > open.line) out.set(open.line, line);
    }
  }
  return out;
}

/** 显示行：原文行号 + 文本 + 折叠标记 */
interface DisplayLine {
  /** 原文 0 基行号 */
  src: number;
  text: string;
  /** 这一行是否是可折叠块的起始行 */
  foldable: boolean;
  /** 这一行是否处于折叠状态 */
  folded: boolean;
}

/** 按当前折叠状态，把原文切成「实际要显示的行」 */
function buildDisplay(): DisplayLine[] {
  const lines = fullText.split('\n');
  const out: DisplayLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const end = blocks.get(i);
    const isFolded = folds.has(i) && end !== undefined;
    out.push({ src: i, text: lines[i], foldable: end !== undefined, folded: isFolded });
    if (isFolded) {
      // 跳过被折叠的中间行，但保留闭合括号那一行（和 VS Code 一致）
      out.push({ src: end, text: lines[end], foldable: false, folded: false });
      i = end;
    }
  }
  return out;
}

/**
 * JSON 语法高亮：把文本切成 token 并包成带 class 的 span。
 *
 * 为什么不用简单正则：字符串里可能含 `{`、`//`、转义引号，
 * 用正则很容易切错。这里做一次单遍扫描，状态机只关心「在不在字符串里」，
 * 字符串内部整体吃掉，保证不会把 `"a{b"` 误判成结构。
 *
 * 配色对齐 VS Code 浅色主题：
 *   key      #0451a5  深蓝
 *   string   #a31515  暗红
 *   number   #098658  绿
 *   boolean  #0000ff  蓝
 *   null     #0000ff  蓝
 *   punct    #333333  深灰
 */
function highlightJson(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;

  /** 把一段纯文本转义成 HTML */
  const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

  while (i < n) {
    const c = text[i];

    // 字符串：整体吃掉（含转义），判断它是 key 还是 value
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') {
          j++;
          break;
        } else j++;
      }
      const raw = text.slice(i, j);
      // 往后看第一个非空白字符，是 ':' 就说明这是 key
      let k = j;
      while (k < n && /\s/.test(text[k]!)) k++;
      const isKey = text[k] === ':';
      out += `<span class="${isKey ? 'hl-key' : 'hl-str'}">${escHtml(raw)}</span>`;
      i = j;
      continue;
    }

    // 数字（含负号、小数、指数）
    if (/[-0-9]/.test(c) && /[-0-9]/.test(c)) {
      let j = i;
      while (j < n && /[-+0-9.eE]/.test(text[j]!)) j++;
      const raw = text.slice(i, j);
      if (/^-?\d/.test(raw)) {
        out += `<span class="hl-num">${escHtml(raw)}</span>`;
        i = j;
        continue;
      }
    }

    // 字面量 true / false / null
    const rest = text.slice(i, i + 5);
    const lit = /^(true|false|null)/.exec(rest);
    if (lit) {
      const kw = lit[1]!;
      out += `<span class="hl-lit">${kw}</span>`;
      i += kw.length;
      continue;
    }

    // 结构符号与空白
    if ('{}[],:'.includes(c)) {
      out += `<span class="hl-punct">${escHtml(c)}</span>`;
    } else {
      out += escHtml(c);
    }
    i++;
  }

  return out;
}

/* ---------------- 渲染 ---------------- */

function render(): void {
  const title = (currentPath ? currentPath.split(/[\\/]/).pop() : '未命名') + (dirty ? ' *' : '');
  const saveDisabled = !currentPath ? 'disabled' : '';
  const foldHint = folds.size ? `<span class="jb-foldhint">已折叠 ${folds.size} 处 · 点击行号栏箭头展开</span>` : '';

  app.innerHTML = `
    <div class="jb">
      <header class="jb-head">
        <span class="jb-title" title="${esc(currentPath ?? '未命名')}">${esc(title)}</span>
        <div class="jb-tools">
          <button class="btn primary" data-act="format" title="把内容解析成 JSON 并按 2 空格缩进">格式化</button>
          <button class="btn" data-act="open">打开</button>
          <button class="btn" data-act="save" ${saveDisabled}>保存</button>
          <button class="btn" data-act="saveAs">另存为</button>
        </div>
      </header>
      <main class="jb-main">
        <div class="jb-editor">
          <div class="jb-gutter"></div>
          <div class="jb-code">
            <pre class="jb-highlight" aria-hidden="true"></pre>
            <textarea class="jb-text" wrap="off" spellcheck="false" placeholder="粘贴 JSON 到这里…"></textarea>
          </div>
        </div>
      </main>
      <footer class="jb-status"><span id="status">就绪</span>${foldHint}</footer>
    </div>`;
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector('.jb-text') as HTMLTextAreaElement;
}

function gutterEl(): HTMLElement {
  return document.querySelector('.jb-gutter') as HTMLElement;
}

function highlightEl(): HTMLElement {
  return document.querySelector('.jb-highlight') as HTMLElement;
}

/** 把高亮层内容同步成 textarea 的文本（两者必须逐字节一致才能对齐） */
function syncHighlight(): void {
  const ta = textarea();
  // 末尾多一个换行，否则最后一行高度会比 textarea 少 1 行，导致滚动错位
  highlightEl().innerHTML = highlightJson(ta.value) + '\n';
}

function setStatus(msg: string, isErr = false): void {
  const el = document.getElementById('status')!;
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function scrollToTop(): void {
  const ta = textarea();
  ta.scrollTop = 0;
  ta.scrollLeft = 0;
  gutterEl().scrollTop = 0;
}

/** 只重建行号栏 + 高亮层（编辑时用，绝不动 textarea.value，否则光标会跳） */
function refreshGutter(): void {
  const display = buildDisplay();
  const html: string[] = [];
  for (let i = 0; i < display.length; i++) {
    const d = display[i];
    const arrow = d.foldable
      ? `<span class="g-arrow" data-line="${d.src}" title="${d.folded ? '展开' : '折叠'}">${d.folded ? '▸' : '▾'}</span>`
      : `<span class="g-arrow g-arrow-none"></span>`;
    html.push(`<div class="g-line"><span class="g-num">${d.src + 1}</span>${arrow}</div>`);
  }
  gutterEl().innerHTML = html.join('');
  // 折叠态只读；行号栏和文本区保持同一滚动位置
  const ta = textarea();
  ta.readOnly = folds.size > 0;
  gutterEl().scrollTop = ta.scrollTop;
  syncHighlight();
  syncScroll();
  syncFoldHint();
}

/** 高亮层跟随 textarea 滚动（两者是叠加关系，必须同源滚动） */
function syncScroll(): void {
  const ta = textarea();
  const hl = highlightEl();
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

/** 底部提示里的折叠计数需要跟着变 */
function syncFoldHint(): void {
  const foot = document.querySelector('.jb-status');
  if (!foot) return;
  const old = foot.querySelector('.jb-foldhint');
  if (old) old.remove();
  if (folds.size) {
    const s = document.createElement('span');
    s.className = 'jb-foldhint';
    s.textContent = `已折叠 ${folds.size} 处 · 点击行号栏箭头展开`;
    foot.appendChild(s);
  }
}

/** 整体重绘内容（打开/格式化/保存后走这里） */
function renderView(): void {
  const ta = textarea();
  const display = buildDisplay();
  ta.value = display.map((d) => d.text).join('\n');
  refreshGutter();
}

/** 折叠/展开某个块 */
function toggleFold(line: number): void {
  if (!blocks.has(line)) return;
  if (folds.has(line)) folds.delete(line);
  else folds.add(line);
  renderView();
  // 折叠后滚回顶部，避免视图跳动
  scrollToTop();
}

/* ---------------- 动作 ---------------- */

/**
 * 取真实内容（唯一可信来源）。
 *
 * 折叠时 textarea 是只读的「显示层」，内容必须用 fullText；
 * 非折叠时把 textarea 的当前值同步回 fullText，避免任何路径下
 * （程序化赋值、粘贴后未触发 input 等）读到过期内容。
 */
function currentContent(): string {
  if (folds.size === 0) fullText = textarea().value;
  return fullText;
}

function doFormat(): void {
  const r = tryFormat(currentContent());
  if (r.ok) {
    fullText = r.output;
    folds.clear();
    blocks = computeBlocks(fullText);
    if (!currentPath) setDirty(fullText.length > 0);
    renderView();
    scrollToTop();
    setStatus('格式化完成');
  } else {
    setStatus(r.error, true);
  }
}

async function doOpen(): Promise<void> {
  const r = await window.tool.openFile();
  if (!r) return;
  if (r.error) {
    setStatus(`打开失败：${r.error}`, true);
    return;
  }
  currentPath = r.path;
  fullText = r.content ?? '';
  folds.clear();
  blocks = computeBlocks(fullText);
  dirty = false;
  render();
  bindEditor();
  renderView();
  setStatus(`已打开 ${r.path}`);
  focusAndSelect();
}

async function doSave(): Promise<void> {
  if (!currentPath) return doSaveAs();
  const r = await window.tool.saveFile(currentPath, currentContent());
  if (r.ok) {
    dirty = false;
    setStatus(`已保存 ${r.path}`);
    render();
    bindEditor();
    renderView();
    focusAndSelect();
  } else {
    setStatus(`保存失败：${r.error}`, true);
  }
}

async function doSaveAs(): Promise<void> {
  const defaultName = currentPath?.split(/[\\/]/).pop() ?? 'untitled.json';
  const r = await window.tool.saveFileAs(defaultName, currentContent());
  if (!r) return;
  if (r.ok) {
    currentPath = r.path ?? null;
    dirty = false;
    setStatus(`已保存 ${r.path}`);
    render();
    bindEditor();
    renderView();
    focusAndSelect();
  } else {
    setStatus(`保存失败：${r.error}`, true);
  }
}

function setDirty(v: boolean): void {
  dirty = v;
  const titleEl = document.querySelector('.jb-title') as HTMLElement;
  if (titleEl) {
    const base = currentPath ? currentPath.split(/[\\/]/).pop()! : '未命名';
    titleEl.textContent = base + (dirty ? ' *' : '');
  }
}

function focusAndSelect(): void {
  const ta = textarea();
  ta.focus();
  ta.select();
}

/** 编辑区交互（render 会重建 DOM，每次 render 后要重绑） */
function bindEditor(): void {
  const ta = textarea();
  ta.addEventListener('input', () => {
    fullText = ta.value;
    blocks = computeBlocks(fullText);
    setDirty(true);
    refreshGutter();
  });
  ta.addEventListener('scroll', () => {
    gutterEl().scrollTop = ta.scrollTop;
    syncScroll();
  });
}

function handleAction(act: string): void {
  switch (act) {
    case 'format':
      doFormat();
      break;
    case 'open':
      void doOpen();
      break;
    case 'save':
      void doSave();
      break;
    case 'saveAs':
      void doSaveAs();
      break;
  }
}

/* ---------------- 启动 ---------------- */

render();
bindEditor();
blocks = computeBlocks(fullText);
renderView();

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;

  // 行号栏箭头：折叠 / 展开
  const arrow = t.closest('.g-arrow') as HTMLElement | null;
  const lineAttr = arrow?.dataset.line;
  if (arrow && lineAttr !== undefined) {
    toggleFold(Number(lineAttr));
    return;
  }

  const btn = t.closest('[data-act]') as HTMLElement | null;
  if (btn?.dataset.act) handleAction(btn.dataset.act);
});

// 折叠态是只读的：点编辑区提示先展开，避免用户以为卡死
app.addEventListener('mousedown', (e) => {
  const ta = (e.target as HTMLElement).closest('.jb-text');
  if (ta && folds.size === 0) return;
  if (ta && folds.size > 0) {
    setStatus('折叠状态下只读，点行号栏的 ▸ 展开后可编辑');
  }
});

// 快捷键：Ctrl+S 保存，Ctrl+Shift+S 另存，Ctrl+O 打开，Ctrl+Shift+F 格式化
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's' && e.shiftKey) {
    e.preventDefault();
    void doSaveAs();
  } else if (k === 's') {
    e.preventDefault();
    void doSave();
  } else if (k === 'o') {
    e.preventDefault();
    void doOpen();
  } else if (k === 'f' && e.shiftKey) {
    e.preventDefault();
    doFormat();
  }
});

textarea().focus();
