// JSON 格式化小工具。
//
// 编辑器：Monaco（VS Code 同款），自带虚拟滚动、行号、折叠、语法高亮、
// 真实 JSON 校验（红色波浪线）、查找替换，选区与渲染同一套管线，天然无错位。
//
// 加载方式：AMD loader（vs/loader.js）+ 脚本标签（无 eval，兼容 CSP script-src 'self'）。
// 容错格式化 / 提取 JSON 等逻辑保留自研（纯字符串处理，与编辑器无关）。

import type * as Monaco from 'monaco-editor';

const app = document.getElementById('app')!;

/** 当前打开的文件路径；null 表示未关联文件 */
let currentPath: string | null = null;

/** 是否有未保存的修改 */
let dirty = false;

/** 编辑器实例 */
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;

/** AMD loader 全局 require（由 Monaco vs/loader.js 注入） */
declare const require: any;

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
 */
function tolerantRepair(text: string): string {
  let s = text;

  s = s.replace(/("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (m, dq, sq, comment) => {
    if (dq != null || sq != null) return m;
    return '';
  });

  s = s.replace(/,\s*([\]}])/g, '$1');

  s = s.replace(/'(\\.|[^'\\])*'/g, (m) => '"' + m.slice(1, -1).replace(/"/g, '\\"') + '"');

  s = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$\-.]*)(\s*:)/g, '$1"$2"$3');

  return s;
}

function tryFormat(text: string): { ok: true; output: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, output: '' };

  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, output: JSON.stringify(parsed, null, 2) };
  } catch (e) {
    try {
      const repaired = tolerantRepair(trimmed);
      const parsed = JSON.parse(repaired);
      return { ok: true, output: JSON.stringify(parsed, null, 2) };
    } catch {
      /* 降级到容错排版 */
    }
    return { ok: false, error: formatError(e) };
  }
}

/**
 * 定位文本中最大的、能完整括号配对的 JSON 片段起止位置（不校验能否 parse）。
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
 */
function prettyPrintTolerant(text: string): string {
  const out: string[] = [];
  let line = '';
  let indent = 0;
  let inStr = false;
  let escNext = false;

  const flush = () => {
    if (line.trim()) out.push('  '.repeat(indent) + line);
    else if (line.length) out.push(line);
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
    if (c === ' ' || c === '\t') continue;

    line += c;
  }
  flush();

  return out.join('\n');
}

/* ---------------- 编辑器（Monaco） ---------------- */

function createEditor(parent: HTMLElement, initialText: string): Monaco.editor.IStandaloneCodeEditor {
  const monaco = (window as any).monaco as typeof Monaco;

  const ed = monaco.editor.create(parent, {
    value: initialText,
    language: 'json',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 20,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: 'none',
    scrollBeyondLastLine: false,
    folding: true,
    foldingHighlight: true,
    foldingStrategy: 'indentation',
    lineNumbers: 'on',
    lineNumbersMinChars: 3,
    renderLineHighlight: 'all',
    roundedSelection: false,
    cursorBlinking: 'blink',
    matchBrackets: 'always',
    bracketPairColorization: { enabled: true },
    wordWrap: 'off',
    smoothScrolling: true,
    fixedOverflowWidgets: true,
    padding: { top: 8, bottom: 8 },
    theme: 'vs',
  });

  // 修改即 dirty
  ed.onDidChangeModelContent(() => {
    dirty = true;
    updateTitle();
  });

  return ed;
}

/* ---------------- 渲染（标题栏 + 状态栏骨架） ---------------- */

function render(): void {
  const title = (currentPath ?? '未命名') + (dirty ? ' *' : '');
  const saveDisabled = !currentPath ? 'disabled' : '';

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
        <div id="monaco-host" class="jb-editor"></div>
      </main>
      <footer class="jb-status"><span id="status">就绪</span></footer>
    </div>`;
}

function setStatus(msg: string, isErr = false): void {
  const el = document.getElementById('status')!;
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function updateTitle(): void {
  const titleEl = document.querySelector('.jb-title') as HTMLElement | null;
  if (titleEl) {
    const base = currentPath ?? '未命名';
    titleEl.textContent = base + (dirty ? ' *' : '');
  }
}

function setDirty(v: boolean): void {
  dirty = v;
  updateTitle();
}

/** 根据当前是否关联文件，切换「保存」按钮的可用状态 */
function updateSaveButton(): void {
  const btn = document.querySelector('[data-act="save"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = !currentPath;
}

/** 当前编辑器内容 */
function currentContent(): string {
  return editor ? editor.getValue() : '';
}

/** 用一段文本整体替换编辑器内容（格式化/提取/打开后走这里） */
function replaceContent(text: string): void {
  if (!editor) return;
  editor.setValue(text);
}

/* ---------------- 动作 ---------------- */

function doFormat(): void {
  const raw = currentContent();
  const r = tryFormat(raw);

  if (r.ok) {
    replaceContent(r.output);
    if (!currentPath) setDirty(r.output.length > 0);
    editor?.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    editor?.setPosition({ lineNumber: 1, column: 1 });
    setStatus('格式化完成');
    return;
  }

  if (raw.trim()) {
    const span = locateJsonSpan(raw);
    let out = raw;
    if (span) {
      const prefix = raw.slice(0, span.start);
      const jsonPart = raw.slice(span.start, span.end);
      const suffix = raw.slice(span.end);
      const prettyJson = prettyPrintTolerant(jsonPart);
      out = (prefix ? prefix + '\n' : '') + prettyJson + (suffix ? '\n' + suffix : '');
    } else {
      out = prettyPrintTolerant(raw);
    }
    replaceContent(out);
    setStatus(`${r.error}（已按结构排版）`, true);
    return;
  }

  setStatus(r.error, true);
}

async function doOpen(): Promise<void> {
  const r = await window.tool.openFile();
  if (!r) return;
  if (r.error) {
    setStatus(`打开失败：${r.error}`, true);
    return;
  }
  currentPath = r.path;
  replaceContent(r.content ?? '');
  setDirty(false);
  updateSaveButton();
  setStatus(`已打开 ${r.path}`);
  focusEditor();
}

async function doSave(): Promise<void> {
  if (!currentPath) return doSaveAs();
  const r = await window.tool.saveFile(currentPath, currentContent());
  if (r.ok) {
    setDirty(false);
    setStatus(`已保存 ${r.path}`);
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
    setDirty(false);
    updateSaveButton();
    setStatus(`已保存 ${r.path}`);
    updateTitle();
  } else {
    setStatus(`保存失败：${r.error}`, true);
  }
}

function focusEditor(): void {
  editor?.focus();
}

/* ---------------- 动作分发 ---------------- */

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

function bootstrap(): void {
  render();
  const host = document.getElementById('monaco-host')!;
  editor = createEditor(host, '');

  app.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (btn?.dataset.act) handleAction(btn.dataset.act);
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

  focusEditor();
}

// Monaco 环境配置：JSON worker（真实语法校验要用的）
(self as any).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') {
      return new Worker('vs/language/json/json.worker.js');
    }
    return new Worker('vs/editor/editor.worker.js');
  },
};

// 配置 AMD loader 并加载 Monaco 编辑器核心
require.config({ paths: { vs: 'vs' } });
require(['vs/editor/editor.main'], bootstrap);
