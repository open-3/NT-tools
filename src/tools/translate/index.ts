// 翻译工具：内嵌百度翻译页面。
//
// 为什么用 <webview> 而不是 <iframe>：
//   百度翻译有 X-Frame-Options / frame-ancestors 限制，iframe 会被拒绝渲染。
//   webview 是独立的 guest 渲染进程，不受宿主页面的同源与框架限制。
//
// 这个工具不做翻译逻辑，只负责「把外部网页稳妥地装进窗口」：
//   - 加载中显示遮罩，加载失败给出可操作的错误提示
//   - 提供重载 / 回首页 / 外部浏览器打开三个兜底
//   - 拦截 window.open，交给主进程用系统浏览器打开，避免弹出裸窗口

export {};

interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  loadURL(url: string): void;
  getURL(): string;
  canGoBack(): boolean;
  goBack(): void;
}

const HOME_URL = 'https://fanyi.baidu.com/mtpe-individual/transText?ext_channel=DuSearch';

const view = document.getElementById('view') as WebviewElement;
const mask = document.getElementById('mask')!;
const maskText = mask.querySelector('.tf-mask-text') as HTMLElement;
const statusEl = document.getElementById('status')!;

function setStatus(msg: string, isErr = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isErr);
}

function showMask(text: string): void {
  maskText.textContent = text;
  mask.classList.remove('hidden');
}

function hideMask(): void {
  mask.classList.add('hidden');
}

/* ---------------- webview 事件 ---------------- */

// 开始加载
view.addEventListener('did-start-loading', () => {
  showMask('正在加载…');
  setStatus('加载中…');
});

// 加载完成
view.addEventListener('did-stop-loading', () => {
  hideMask();
  try {
    setStatus(view.getURL());
  } catch {
    setStatus('已加载');
  }
});

// 加载失败：给出可操作的提示，而不是白屏
view.addEventListener('did-fail-load', ((e: any) => {
  // -3 是 ABORTED，通常是用户主动跳转/重载触发，不算失败
  if (e.errorCode === -3) return;
  hideMask();
  const desc = e.errorDescription || `错误码 ${e.errorCode}`;
  setStatus(`加载失败：${desc}`, true);
  showMask('页面加载失败，可点右上角「重载」或「外部打开」');
}) as EventListener);

// 页面标题变化时同步窗口标题
view.addEventListener('page-title-updated', ((e: any) => {
  document.title = e.title ? `${e.title} — 翻译` : '翻译';
}) as EventListener);

// 页面里 window.open：交给主进程用系统浏览器打开，避免弹出不可控的裸窗口
view.addEventListener('new-window', ((e: any) => {
  e.preventDefault?.();
  const url = e.url;
  if (url) window.open(url, '_blank');
}) as EventListener);

/* ---------------- 工具栏 ---------------- */

document.getElementById('btn-reload')!.addEventListener('click', () => {
  showMask('正在重新加载…');
  try {
    view.reload();
  } catch {
    view.loadURL(HOME_URL);
  }
});

document.getElementById('btn-home')!.addEventListener('click', () => {
  showMask('正在回到首页…');
  view.loadURL(HOME_URL);
});

document.getElementById('btn-browser')!.addEventListener('click', () => {
  let url = HOME_URL;
  try {
    url = view.getURL() || HOME_URL;
  } catch {
    /* 取不到就用首页 */
  }
  window.open(url, '_blank');
});

// 初始状态
showMask('正在加载百度翻译…');
setStatus('正在加载…');
