// 正则测试器：实时匹配 + 高亮 + 分组展示
export {};

const pattern = document.getElementById('pattern') as HTMLInputElement;
const test = document.getElementById('test') as HTMLTextAreaElement;
const result = document.getElementById('result')!;
const empty = document.getElementById('empty')!;
const groups = document.getElementById('groups')!;
const countLabel = document.getElementById('count-label')!;
const flagI = document.getElementById('flag-i') as HTMLInputElement;
const flagG = document.getElementById('flag-g') as HTMLInputElement;
const flagM = document.getElementById('flag-m') as HTMLInputElement;
const flagS = document.getElementById('flag-s') as HTMLInputElement;

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function flags(): string {
  return (flagI.checked ? 'i' : '') + (flagG.checked ? 'g' : '') + (flagM.checked ? 'm' : '') + (flagS.checked ? 's' : '');
}

function run(): void {
  const p = pattern.value;
  const text = test.value;

  if (!p) {
    result.innerHTML = `<span class="u-empty" style="display:block;">输入正则表达式</span>`;
    empty.style.display = '';
    groups.innerHTML = '';
    countLabel.textContent = '匹配数';
    return;
  }

  let re: RegExp;
  try {
    re = new RegExp(p, flags());
  } catch (e: any) {
    result.innerHTML = `<div style="color:#cf222e;">正则错误：${esc(e?.message ?? String(e))}</div>`;
    groups.innerHTML = '';
    countLabel.textContent = '匹配数';
    return;
  }

  if (!text) {
    result.innerHTML = `<span class="u-empty" style="display:block;">输入测试文本</span>`;
    groups.innerHTML = '';
    countLabel.textContent = '匹配数';
    return;
  }

  // 重置 lastIndex 避免 g 标志残留
  re.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 10000) {
    matches.push(m);
    if (m.index === re.lastIndex) re.lastIndex++; // 防止空匹配死循环
    if (!flagG.checked) break; // 非 g 只取第一个
  }

  countLabel.textContent = `匹配数：${matches.length}`;

  if (matches.length === 0) {
    result.innerHTML = `<span class="u-empty" style="display:block;color:#cf222e;">无匹配</span>`;
    groups.innerHTML = '';
    return;
  }

  // 高亮：按匹配区间构造 HTML
  const isG = flagG.checked;
  const all = isG ? matches : matches.slice(0, 1);
  let html = '';
  let cursor = 0;
  for (const match of all) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (start > cursor) html += esc(text.slice(cursor, start));
    html += `<mark style="background:#ffe58f;border-radius:3px;padding:0 1px;">${esc(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += esc(text.slice(cursor));
  result.innerHTML = html;

  // 分组展示
  const first = matches[0];
  if (first.length > 1) {
    const parts: string[] = [];
    for (let i = 1; i < first.length; i++) {
      parts.push(
        `<div style="font-family:var(--mono);font-size:12px;margin:3px 0;">
          <span style="color:var(--t3);">$(${i})</span> ${esc(first[i] ?? '(未捕获)')}
        </div>`,
      );
    }
    groups.innerHTML = parts.join('');
  } else {
    groups.innerHTML = '<span style="font-size:12px;color:var(--t3);">无捕获分组</span>';
  }
}

[pattern, test, flagI, flagG, flagM, flagS].forEach((el) => {
  el.addEventListener('input', run);
  el.addEventListener('change', run);
});

run();
