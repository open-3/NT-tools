# 图片取字（OCR）

从截图/照片里提取文字。工具箱第三项。

---

## 能力

| 入口 | 说明 |
|---|---|
| 选择图片 | 原生文件对话框 |
| 拖拽 | 把图片拖进左侧区域 |
| **粘贴** | 直接 `Ctrl+V`（截图后最顺手的路径） |

输出区可直接编辑、一键复制。识别结果保留换行。

---

## 引擎可替换（这是本工具的设计重点）

UI 只依赖 `OcrEngine` 接口，不关心背后是什么引擎：

```ts
interface OcrEngine {
  id: string;
  label: string;
  isAvailable(): Promise<boolean>;
  recognize(imageUrl: string, opts): Promise<OcrResult>;
  dispose(): Promise<void>;
}
```

注册表在 `engine.ts`：`registerEngine(id, factory)` / `setActiveEngine(id)`。
当前只注册了 `tesseract`（`engine-tesseract.ts`）。

**换引擎 = 新写一个实现 + 改一行 `registerEngine`**，UI 与交互零改动。

### 为什么值得抽这层

实测同一张真实网页截图，不同引擎差距是数量级的：

| | tesseract.js | Windows 自带 OCR |
|---|---|---|
| 版面 | 保留换行与段落 | 整页拍成一行 |
| 英文词 | `Baidu` / `API` / `AI` 正确 | `Baid"` / `Al` / `A \| +` |
| 中文 | 连成词（`自动检测`） | 逐字拆（`第 五 轮`） |

所以将来若换更准的引擎，不该为此重写界面。

---

## 语言包内置（不走 CDN）

内置 `chi_sim` + `eng`，共 **4.46MB**：

```
src/tools/ocr/lang/
├── chi_sim.traineddata.gz  1.64 MB
└── eng.traineddata.gz      2.82 MB
```

### 这里踩过一个坑，值得记

一开始我下的是 `tessdata.projectnaptha.com/4.0.0/*.gz`（浮点版，chi_sim 19MB）。
喂给 tesseract.js 的 WASM 后，输出**大量形近字误识**：

```
文本 → 割河      翻译 → 桓喜译      上传 → 上传国片
```

改成 CDN 用的那份 `@tesseract.js-data/*/4.0.0_best_int`（整数量化版）后，
**同一张图、同一个 WASM，结果完全正确**。

**结论：tesseract 的 traineddata 必须和 WASM 的量化方式匹配。**
`4.0.0`（浮点）≠ `4.0.0_best_int`（int 量化），混用就是形近字乱码。
而且 int 版反而**小 10 倍**（42MB → 1.64MB）。

---

## WASM 只带一个变体

`tesseract.js-core` 里有 6 个 wasm 变体（普通 / simd / relaxedsimd × 带不带 lstm），
全带是 42MB。实测运行时**只加载 `tesseract-core-relaxedsimd-lstm`** 这一个。

`runtime.json` 精确声明后，工具目录从 47.35MB 降到 **11.17MB**：

```json
{
  "copy": [
    { "from": "node_modules/tesseract.js/dist", "include": ["worker.min.js"] },
    { "from": "node_modules/tesseract.js-core",
      "include": ["tesseract-core-relaxedsimd-lstm.wasm",
                  "tesseract-core-relaxedsimd-lstm.wasm.js"] }
  ]
}
```

> 注：`.wasm.js` 是 emscripten 的加载器，只复制 `.wasm` 会报
> `importScripts ... failed to load`。
>
> 升级 tesseract 大版本后若报这个错，把 include 改回 `*.wasm` / `*.wasm.js`
> 重新确认实际用哪个变体。

---

## 精度实测

清晰文字图（白底、常规字号）：

```
识别完成，6 行 · 862ms · 置信度 89%
Agent Pulse 工具 箱
图 片 取 字 OCR 测试
order No: A20261105001        ← 数字完全正确
Amount: 1280.50 CNY           ← 小数正确
识别 引擎 可 以 替换 ， 语 言 包 已 内 置 。
支持 粘贴 图 片 与 拖 搜 上 传 。   ← 拖拽→拖搜，唯一误识
```

真实网页截图（小字、复杂背景、彩色）：

```
13 行 · 2666ms · 置信度 74%
文本 翻译 MEE BREE          ← 按钮文字误识较多
自动 检测 “= 中文 (简体 ) ~ AI 大 模型 翻译 ©   ← 主文案基本正确
```

**能力边界**：

- ✅ 白底、字号正常的文字：置信度 85%+，数字/英文准确
- ⚠️ 小字、复杂背景、彩色 UI 截图：置信度 70-75%，有误识
- ❌ 不适合：手写体、严重倾斜、低分辨率

中文在结果里会带空格（tesseract 的分词结果），不影响阅读与复制。

---

## 性能

| 项 | 实测 |
|---|---|
| 首次初始化 | 约 2 秒（加载 WASM + 语言包） |
| 单张识别 | 862ms（清晰图）/ 2.7s（大图） |
| 工具目录 | 11.17 MB |

worker 在窗口关闭时释放（`beforeunload` → `disposeEngine()`），
因为 WASM 实例常驻会占几十 MB。

---

## 新增工具的接线方式

这个工具验证了工具箱的扩展性，加它只动了三处：

1. `src/main/tools.ts` 的 `TOOLS` 加一行
2. 建 `src/tools/ocr/` 目录
3. `runtime.json` 声明运行时依赖

**构建脚本零改动** —— 它会自动扫描 `src/tools/*/`、复制静态资源、
按 `runtime.json` 拉取 npm 包里的运行时文件。

（唯一一次改构建脚本是支持 `runtime.json` 这个机制本身，之后所有工具都能用。）
