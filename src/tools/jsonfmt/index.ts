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
// window.tool 的完整类型见 src/tools/global.d.ts，这里不再重复声明
export {};

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

/**
 * 容错：把常见「不规范的 JSON」修成能解析的样子。
 * 覆盖：单引号、无引号 key、尾逗号、注释。
 * 这是「尽力而为」，不保证语义，只为把内容格式化出来而非直接报错。
 */
function tolerantRepair(text: string): string {
  let s = text;

  // 1) 去掉注释（// 和 /* */）—— 但要跳过字符串内部
  s = s.replace(/("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (m, dq, sq, comment) => {
    if (dq != null || sq != null) return m; // 字符串内不动
    return ''; // 注释删掉
  });

  // 2) 尾逗号：, 紧跟着 ] 或 } 去掉
  s = s.replace(/,\s*([\]}])/g, '$1');

  // 3) 单引号字符串 → 双引号（跳过已处理的双引号字符串）
  s = s.replace(/'(\\.|[^'\\])*'/g, (m) => '"' + m.slice(1, -1).replace(/"/g, '\\"') + '"');

  // 4) 无引号 key：{ 或 , 后面的标识符或包含 -_. 的 key → 加引号
  s = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$\-.]*)(\s*:)/g, '$1"$2"$3');

  return s;
}


/**
 * 从任意文本中提取 JSON 片段（多候选）。
 *
 * 日志里常有 `[线程名] [级别]` 这类方括号，会干扰「找第一个 { 或 [」。
 * 所以这里遍历每个 { 或 [ 起始点，逐个做括号配对，返回**第一个能成功
 * JSON.parse**（必要时经过容错修复）的完整片段。
 */
function extractJsonFragment(text: string): { json: string; stripped: boolean } | null {
  // 收集所有 { 和 [ 的起始位置（跳过字符串内部）
  const starts: number[] = [];
  let inStr = false;
  let escNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
    if (c === '{' || c === '[') starts.push(i);
  }

  for (const start of starts) {
    const openCh = text[start]!;
    const closeCh = openCh === '{' ? '}' : ']';
    const stack: string[] = [openCh];
    inStr = false;
    escNext = false;
    for (let i = start + 1; i < text.length; i++) {
      const c = text[i]!;
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
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        stack.pop();
        if (stack.length === 0) {
          const json = text.slice(start, i + 1);
          // 这个片段能解析吗？（严格 + 容错）
          try {
            JSON.parse(json);
          } catch {
            try {
              JSON.parse(tolerantRepair(json));
            } catch {
              break; // 这个候选不行，试下一个起点
            }
          }
          const stripped = start > 0 || i + 1 < text.length;
          return { json, stripped };
        }
      }
    }
  }
  return null;
}

function tryFormat(text: string): { ok: true; output: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, output: '' };

  // 1) 严格解析整段
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, output: JSON.stringify(parsed, null, 2) };
  } catch (e) {
    // 2) 容错修复后再试
    try {
      const repaired = tolerantRepair(trimmed);
      const parsed = JSON.parse(repaired);
      return { ok: true, output: JSON.stringify(parsed, null, 2) };
    } catch {
      /* 继续降级，由 doFormat 做排版降级 */
    }
    return { ok: false, error: formatError(e) };
  }
}

/**
 * 定位文本中最大的、能完整括号配对的 JSON 片段起止位置（不校验能否 parse）。
 *
 * 与 extractJsonFragment 的区别：这里**不要求 JSON.parse 成功**，
 * 只要 `{`...`}` 或 `[`...`]` 括号完整配对就返回起止。
 * 用于「报错但仍排版」场景：定位到那坨 JSON，只排版它，前后的日志保留原样。
 */
function locateJsonSpan(text: string): { start: number; end: number } | null {
  const braceStarts: number[] = [];
  const bracketStarts: number[] = [];
  let inStr = false;
  let escNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
    if (c === '{') braceStarts.push(i);
    else if (c === '[') bracketStarts.push(i);
  }

  // 优先找 `{...}` 对象（日志里 `[...]` 方括号很常见，如线程名，容易误判）；
  // 没有对象时才用 `[...]`（顶层数组场景）。
  const allStarts = [...braceStarts, ...bracketStarts];

  for (const start of allStarts) {
    const openCh = text[start]!;
    const closeCh = openCh === '{' ? '}' : ']';
    const stack: string[] = [openCh];
    inStr = false;
    escNext = false;
    for (let i = start + 1; i < text.length; i++) {
      const c = text[i]!;
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
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        stack.pop();
        if (stack.length === 0) {
          return { start, end: i + 1 };
        }
      }
    }
  }
  return null;
}

/**
 * 容错排版：把「不规范的 JSON 文本」按括号深度换行缩进。
 *
 * 与 JSON.stringify(..., 2) 不同，它**不依赖 JSON.parse 成功**：
 * 逐字符扫描，遇到 `{` / `[` 缩进 +1 并换行，`}` / `]` 缩进 -1 先换行，
 * `,` 换行，`:` 后补空格，字符串整体原样保留（内部不拆）。
 *
 * 这样即使 JSON 有语法错误（缺失括号、多余逗号、日志前缀残片等），
 * 用户也能得到「分行、缩进、可读」的视图 —— 对齐 NineTwoToolApp
 * 用 Monaco 得到的效果：报错但仍按 JSON 结构换行显示，而不是缩成整行。
 */
function prettyPrintTolerant(text: string): string {
  const out: string[] = [];
  let line = '';
  let indent = 0;
  let inStr = false;
  let escNext = false;

  const flush = () => {
    if (line.trim()) out.push('  '.repeat(indent) + line);
    else if (line.length) out.push(line); // 保留纯空行
    line = '';
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (inStr) {
      line += c;
      if (escNext) escNext = false;
      else if (c === '\\') escNext = true;
      else if (c === '"') inStr = false;
      continue;
    }

    if (c === '"') {
      inStr = true;
      line += c;
      continue;
    }

    if (c === '{' || c === '[') {
      line += c;
      indent++;
      flush();
      continue;
    }
    if (c === '}' || c === ']') {
      flush();
      indent = Math.max(0, indent - 1);
      line += c;
      continue;
    }
    if (c === ',') {
      line += c;
      flush();
      continue;
    }
    if (c === ':') {
      line += ': ';
      continue;
    }
    if (c === '\n' || c === '\r') {
      flush();
      continue;
    }
    // 普通空白：跳过（换行缩进由 flush 统一处理）
    if (c === ' ' || c === '\t') continue;

    line += c;
  }
  flush();

  return out.join('\n');
}

/** 记录当前编辑器的错误位置（供高亮层标记），-1 表示无错误 */
let errorPos = -1;

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

  /** 把一段纯文本转义成 HTML */
  const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

  let i = 0;
  const n = text.length;

  while (i < n) {
    // 到达错误位置：单独输出这一个字符，包红色波浪下划线标记，
    // 跳过正常 token 处理（errorPos 通常落在结构符号或非法字符上）
    if (errorPos === i) {
      const ch = text[i]!;
      out += `<span class="hl-err-mark">${escHtml(ch)}</span>`;
      i++;
      continue;
    }

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
          <button class="btn" data-act="extract" title="从文本中提取 JSON 片段（会移除前后非 JSON 内容）">提取 JSON</button>
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
  const raw = currentContent();
  const r = tryFormat(raw);
  errorPos = -1;
  if (r.ok) {
    fullText = r.output;
    folds.clear();
    blocks = computeBlocks(fullText);
    if (!currentPath) setDirty(fullText.length > 0);
    renderView();
    scrollToTop();
    setStatus('格式化完成');
    return;
  }

  // 不是合法 JSON：**不静默删数据**，但仍把 JSON 部分「分行排版」，
  // 让用户看到结构而不是缩成一整行。日志前缀/后缀原样保留。
  if (raw.trim()) {
    const span = locateJsonSpan(raw);

    if (span) {
      // 定位到完整配对的 JSON 片段：只排版它，前后非 JSON 保留原样
      const prefix = raw.slice(0, span.start);
      const jsonPart = raw.slice(span.start, span.end);
      const suffix = raw.slice(span.end);
      const prettyJson = prettyPrintTolerant(jsonPart);

      fullText = (prefix ? prefix + '\n' : '') + prettyJson + (suffix ? '\n' + suffix : '');
    } else {
      // 没有完整配对的 JSON 片段（连括号都配不平）：整段按结构排版
      fullText = prettyPrintTolerant(raw);
    }

    folds.clear();
    blocks = computeBlocks(fullText);
    if (!currentPath) setDirty(fullText.length > 0);

    // 排版后重新定位错误：对排版后的内容再 parse 一次，拿到对应当前文本的错误位置
    errorPos = -1;
    try {
      JSON.parse(fullText);
    } catch (e2) {
      const m2 = /position (\d+)/.exec(e2 instanceof Error ? e2.message : String(e2));
      if (m2) errorPos = Number(m2[1]);
    }

    renderView();
    scrollToTop();
    setStatus(`${r.error}（已按结构排版，错误处标红；若是日志夹 JSON，点「提取 JSON」）`, true);
    return;
  }

  setStatus(r.error, true);
}

/**
 * 提取 JSON：显式地从文本中抠出 JSON 片段（去掉日志前缀/后缀）。
 *
 * 这是**用户主动发起的操作**，不是「格式化」的隐式副作用。
 * 提取后状态栏会明确提示「已提取，前后非 JSON 内容已移除」，
 * 让用户清楚知道数据被裁剪过，而不是误以为原文就是纯 JSON。
 */
function doExtract(): void {
  const raw = currentContent().trim();
  if (!raw) {
    setStatus('内容为空，无可提取', true);
    return;
  }

  const frag = extractJsonFragment(raw);
  if (!frag) {
    setStatus('未找到可提取的 JSON（没有配对的 { 或 [ ）', true);
    return;
  }

  // 提取后仍要能格式化：严格解析或容错
  let output = frag.json;
  try {
    output = JSON.stringify(JSON.parse(frag.json), null, 2);
  } catch {
    try {
      output = JSON.stringify(JSON.parse(tolerantRepair(frag.json)), null, 2);
    } catch {
      setStatus(`提取到了候选片段，但不是合法 JSON：${frag.json.slice(0, 60)}…`, true);
      return;
    }
  }

  fullText = output;
  folds.clear();
  blocks = computeBlocks(fullText);
  if (!currentPath) setDirty(fullText.length > 0);
  renderView();
  scrollToTop();

  const removed = raw.length - frag.json.trim().length;
  setStatus(`已提取 JSON，移除了 ${removed} 个字符的前后非 JSON 内容`);
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
    errorPos = -1; // 用户改了文本，错误标记失效
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
    case 'extract':
      doExtract();
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
