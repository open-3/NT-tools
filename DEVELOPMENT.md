# Agent Pulse · 开发文档

> 这份是**技术实现文档**（架构、数据源、性能调优、踩坑记录）。
> 只想了解功能怎么用，看 [README.md](README.md)。

并发 Agent 状态浮窗。只读聚合 Codex、DeepSeek Harness 与 WorkBuddy 的本地运行态，
把「正在进行的对话」和「跑完但还没看的对话」收在一个始终浮在桌面上的小窗里。

设计文档：[../桌面Agent状态浮窗-设计方案.md](../桌面Agent状态浮窗-设计方案.md)

---

## 快速开始

```bash
cd app
npm install
npm start          # 构建 + 启动
npm test           # 跑单测
```

首次启动后，浮窗会出现在主屏右侧偏上。托盘图标在通知区域。

当前已接入 3 个工具：**Codex**（`C` 青绿）、**DeepSeek Harness**（`D` 紫）、
**WorkBuddy**（`W` 蓝，含国内版与国际版）。检测不到的工具不显示，也不报错。

---

## 它显示什么

可见集合 = `待确认` ∪ `进行中` ∪ `完成未读`，统一一个列表，按此顺序排。
其余一律不显示；全部空闲时列表为空，2 秒后自动收成细条。

| 状态 | 判定依据（Codex） | 判定依据（DSH） | 判定依据（WorkBuddy） |
|---|---|---|---|
| 待确认 | `inProgress` 且 60s 无文件增长（**推断**，空心点） | `approval/asked` 无对应 `approval/decided`（**精确**） | `sessions.status='pending'`（**精确**） |
| 进行中 | `thread_turns.status='inProgress'` | `sessionStats.openStep != null` | `status ∈ {working, planning, finalizing}` |
| 完成未读 | `thread_read_receipts.first_unread_turn` 非空 | 最后事件是 `turn/end` 且未 ack | `status ∈ {completed, failed}` 且 `unread=1` |

### 一行卡片上放什么

```
[C] 转换                        sam…local   39m
    ● 已调整为至少保留两个 end。· ⎇ feature-a   8 文件
```

| 位置 | 内容 | 数据来源 |
|---|---|---|
| 标题行 | 会话标题 + **项目名**（压缩到 20 字符）+ 时长 | 三工具都有 |
| 第二行 | 状态点 + **结果摘要**（完成项）/ 当前动作（进行中）/ 等待原因（待确认） | Codex、DSH |
| 第二行右 | **改动文件数** | 仅 Codex |
| 第二行尾 | **git 分支**（`main`/`master` 不显示） | Codex、DSH |

**为什么项目名要压缩**：`acme-service-backend-local` 完整显示占 96px，
362px 的卡片里标题会被挤到 76px，看不清会话本身。压缩成
`acme-service…backend-local`（首段 + … + 末段）后占 57px。

**为什么分支不放标题行**：项目名 + 分支 + 文件数三个一起上，标题只剩 76px。
分支信息量低于项目名，所以下沉到第二行。

### 列表高度上限

卡片按内容自适应，但条数一多窗口会长到屏幕外：实测 30 条 = 972px、50 条 = 1988px，
而 1280 屏可用高度只有 1232px——底部条目永远看不到也点不到。

所以 `.p-list` 有 600px 上限（约 11 条），超出部分在列表内部滚动。
整窗封顶 672px，768p 笔记本（可用约 728px）仍放得下。

**关于 WorkBuddy 的「待确认」**：WorkBuddy 的 conversation 状态机是
`idle → planning → working → finalizing → pending → idle`，其中 `pending` 的
转移条件明确写着「用户应答权限/问答」（对应事件 `PERMISSION_REQUESTED` /
`PERMISSION_RESOLVED`）。该状态由 `updateSessionStatus()` 写入 `sessions.status`。
所以 `status='pending'` 是**精确**的待确认信号。

**关于 Codex 的「待确认」**：Codex 的 rollout 日志和 `thread_items` 里都没有审批事件，
Windows 上 `codex app-server daemon` 也不可用，所以拿不到精确信号。
只能用「长时间无输出」推断，并以空心点 + 降透明度弱化显示，避免误判焦虑。

---

## 快捷键

| 键 | 作用 |
|---|---|
| `Alt+Shift+A` | 显示 / 隐藏浮窗 |
| `Alt+Shift+C` | 折叠 / 展开 |
| `Esc` | 折叠 |
| 单击卡片 | 标记已读 |
| 右键卡片 | 复制结果摘要 / 已读 / 忽略 1h / 永久忽略 / 复制 ID |

> **不做跳转**：点击卡片只标记已读，不会切换或激活其他应用的窗口。
> 早期版本做过「点击把工具窗口弹到最前」，后来按需求撤销了。

---

## 调度向的增量功能

这些不是「多显示点信息」，而是围绕一个判断做的：**现在我该处理哪一件**。

| 功能 | 解决什么 |
|---|---|
| **待确认排最前，同级按等得久** | 刚启动 3 秒的新会话不该把等了 2 小时的待确认挤下去 |
| **结果摘要**（完成项） | 「已完成」三个字等于没说。直接显示它最后给了什么，不用点开 |
| **右键复制摘要** | 想接着用这个结果时，不用去翻原对话 |
| **完成项折叠** | 完成未读 > 3 条时收成一行「N 项已完成未读 · 展开」，别把要处理的挤出视野 |
| **底栏负载总览** | `● 2 等我 ● 1 在跑 ● 5 完成`，彩色点比纯文字快 |
| **项目上下文标签** | 「转换」这种短标题，不显示项目名根本分不清是哪个活 |
| **改动文件数** | 完成项一眼看出这次动了几处，判断要不要认真看 |
| **额度告警** | 接近上限时才出现，平时不存在 |
| **停滞感知** | 进行中 >10 分钟无活动变琥珀「已停 X 分钟」；>60 分钟「可能卡住」 |
| **进度感知** | 运行态显示「第 N 轮」，一眼看出这活干了多久还要等多久 |
| **过期预警** | 完成未读快滚出 2 小时窗口时提示「还剩 X 分钟」 |

---

## 额度告警

Codex 的 rollout 里每条 `token_count` 事件都带 `rate_limits`，
这是 **OpenAI 服务端下发的权威数据**：

```json
{"primary":  {"used_percent": 8, "window_minutes": 300,   "resets_at": ...},
 "secondary":{"used_percent":63, "window_minutes": 10080, "resets_at": ...}}
```

`primary` 是 5 小时滚动窗，`secondary` 是 7 天滚动窗。

**只在接近上限时显示**（5h ≥75% / 7d ≥70%），平时完全不存在。
依据：实测 16 天里只有 1 天 5h 窗口破 70%，常驻会变成一块永远不变的装饰，
和「只显示要处理的」这个原则冲突。

放在**页脚**而不是标题栏：标题栏已经放了「N 待确认」，再塞一个 pill
会把 brand 从 71px 挤到 51px（实测）。页脚是「负载」区，标题栏是「待办」区。

> **注意**：曾经加过「今日 token 消耗」并随后下架。原因是自算的 token 数
> 和本机 magpie 网关统计对不上——magpie 能截到每一条请求，而我们从
> rollout/session 文件里重建的总有漏（subagent、走网关但没落盘的、本地拒绝的）。
> 额度百分比是服务端下发的，不受这个影响，所以保留。
> 详见 [功能挖掘-第三轮.md](../功能挖掘-第三轮.md) 的注释。

---

## 工具箱

浮窗标题栏的「工具」按钮打开工具箱，每个工具是一个独立窗口，**可多开**。

| 工具 | 说明 |
|---|---|
| **JSON 格式化** | 行号栏折叠、语法高亮、打开/保存/另存。详见 [src/tools/jsonfmt](src/tools/jsonfmt) |
| **翻译** | 内嵌百度翻译（`<webview>`，绕开 X-Frame-Options） |
| **图片取字** | 本地 OCR，上传/拖拽/`Ctrl+V` 粘贴。详见 [src/tools/ocr/README.md](src/tools/ocr/README.md) |

### 加一个新工具只要两步

1. `src/main/tools.ts` 的 `TOOLS` 数组加一行 `{ id, label, icon }`
2. 建 `src/tools/<id>/`，放 `index.html` / `index.ts` / `style.css`

构建脚本自动扫描 `src/tools/*/` 逐个打包到 `dist/tools/<id>/`，**不用改构建脚本**。
需要 npm 包里的运行时文件（如 wasm）时，在同目录放 `runtime.json` 声明即可。

工具与主浮窗的产物完全隔离（`dist/renderer` vs `dist/tools`），
工具崩了不影响浮窗。

---

## 目录结构

```
app/
├── src/
│   ├── main/
│   │   ├── main.ts              主进程：窗口、托盘、热键、IPC、调度
│   │   ├── store.ts             持久化（窗口位置 / 已读 / 忽略）
│   │   ├── reconcile.ts         合并排序 + 已读过滤
│   │   ├── autocollapse.ts      空态自动折叠状态机（可单测）
│   │   ├── summary.ts           把最终回复压成一行摘要（≤40 字符）
│   │   ├── project.ts           项目名清洗 + 压缩 + 分支归一
│   │   ├── quota.ts             读 Codex rollout 尾部的 rate_limits（额度告警）
│   │   ├── adapters/
│   │   │   ├── types.ts         适配器接口与统一数据模型
│   │   │   ├── codex.ts         Codex 适配器
│   │   │   ├── dsh.ts           DeepSeek Harness 适配器
│   │   │   └── workbuddy.ts     WorkBuddy 适配器（国内版 + 国际版）
│   │   └── sources/
│   │       ├── sqlite.ts        只读 sqlite 封装
│   │       └── zstd.ts          多帧 zstd 解码
│   ├── preload/preload.ts       contextBridge 暴露的最小 API
│   └── renderer/                UI（无框架，纯 DOM）
├── scripts/
│   ├── build-main.mjs           esbuild 打包主进程
│   ├── build-renderer.mjs       esbuild 打包渲染层
│   ├── launch.mjs               启动器（清除干扰变量 / 支持空 HOME 测试）
│   ├── selftest.ts              适配器真实数据自检
│   ├── cdp.mjs                  连到运行中的窗口执行表达式（调试/验收用）
│   ├── shot.mjs                 截当前窗口
│   ├── cdp-log.mjs              收集控制台报错
│   ├── mock-shot.mjs            注入假数据出视觉稿（含冻结轮询）
│   └── test-*.ts                单测
└── build/icon.ico               应用图标
```

---

## 扩展新的 Agent 工具

只需实现 `AgentAdapter` 接口，然后在 `main.ts` 的 `adapters` 数组里加一项：

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly badge: string;          // 列表里显示的单字母徽标
  detect(): boolean;               // 是否安装 / 数据目录是否存在
  snapshot(): AgentSession[];      // 返回当前所有可见会话
}
```

核心逻辑（排序、过滤、已读、UI）零改动。

**已接入的三个工具，数据源差异很大**，可以作为后续适配的参考：

| 工具 | 数据源 | 待确认精确度 |
|---|---|---|
| Codex | sqlite（`state_5.sqlite` + `thread_history_1.sqlite`）+ rollout 文件 mtime | 推断 |
| DeepSeek Harness | projcache JSON + 多帧 zstd 事件流 | 精确 |
| WorkBuddy | sqlite（`workbuddy.db` → `sessions` 表） | 精确 |

Claude Code 可读 `~/.claude/projects/*.jsonl`，思路与 Codex 适配器一致。
注意 WorkBuddy 的双版本（`.workbuddy` / `.workbuddy-ai`）在 `workbuddy.ts` 里
用 `EDITIONS` 数组配置，新增版本只需加一行。

---

## 已知限制

1. **Codex 待确认是推断的**，见上。后续可尝试附着 `codex app-server` 的
   `thread/status/changed` 通知（需常驻进程）。
2. **不写任何 agent 数据**。所有 sqlite 以 `readOnly` 打开，所有文件只读。
   已读/忽略状态存在自己的 `%APPDATA%/agent-pulse/state.json`。
3. **折叠态高度是 40px**，不是设计稿的 32px —— Windows 的 `BrowserWindow`
   有约 38px 的最小高度下限（实测请求 24/30/32/34/36 都得到 38），做 32 会被裁切。
4. **贴桌面模式未实现**。当前只有「置顶」与「不置顶」两档（托盘菜单可切）。
   真正贴在桌面图标之上、普通窗口之下需用 Win32 `SetParent` 到 `WorkerW`，
   本机实测 `Progman` 下确实有 `SHELLDLL_DefView`，但挂载后的 DPI/焦点/多屏行为
   需要专门调试，留到 v0.2 做。
5. **点击穿透未实现**。浮窗是整体可交互的，不做空白区域穿透。
6. **WorkBuddy 无法显示「当前在做什么工具」**。它的 `sessions` 表只有会话级状态，
   没有像 Codex 的 `thread_items` / DSH 的 `tool/call` 那样的细粒度动作记录，
   所以进行中的条目只显示「处理中」，不显示「运行 pwsh」这类细节。
   若要补上，需解析 `~/.workbuddy-ai/logs` 下的 `conversation-runtime` 日志。
7. **WorkBuddy 也没有结果摘要和改动文件数**。它的消息正文在云端，本地
   `workbuddy.db` 只有元数据，所以完成项只能显示「已完成 · 未读」。
   Codex 和 DSH 有摘要，Codex 另有文件数——三者的信息量不对等，这是数据决定的，不是偷懒。
8. **页面 CSP 是 `style-src 'self'`**，渲染层**不能写内联 `style=`**，
   否则会被静默拦掉（表现为分隔符挤在一起、圆点尺寸失效）。样式一律走 CSS 类。
9. **列表超过 11 条要滚动**。不是懒加载也不是分页，就是内部滚动——
   实测日常负载 13 个会话/天，同时可见的极少超过 6 条，封顶 11 条足够，
   不值得为极端情况引入分页交互。
10. **不做自算的 token 用量**。曾经做过「今日 token 消耗」，后来下架——
    从 rollout/session 文件重建的 token 数和本机 magpie 网关（能截到每一条请求）
    对不上。网关是权威，文件重建总有漏。额度告警不受影响，它读的是
    服务端下发的 `rate_limits` 摘要，不是我们算的。

---

## 性能说明（重要）

本机 **GPU 合成被驱动禁用**（`app.getGPUFeatureStatus()` 返回
`gpu_compositing: "disabled_software"`，显卡是 Intel Arc + OrayIdd/Todesk 虚拟显示器）。
这会让任何 CSS 无限动画走软件光栅化并强制持续重绘。实测同一窗口：

| 动画方式 | CPU（单核占比） |
|---|---|
| 无动画 | 0.2% |
| CSS `opacity` 动画 | 14.2% |
| CSS `transform` 动画 | 17.0% |
| CSS `opacity` + `transform` | 22.7% |
| CSS `box-shadow` 动画 | 42.8% |
| **JS 每 700ms 切换 class** | **≈0%** |

所以「呼吸圆点」改用 JS 低频切换实现，实测整机 CPU 从 22.7% 降到 **3.5%**。

### 同一条规则也适用于数据刷新

这条规则不只管动画：任何**高频变化的数据**都不能走整表重绘。
`paint()` 是 `root.innerHTML = renderFull(snap)`，整棵 DOM 销毁重建，
卡片一多这台机器就吃不消。

所以停滞/过期这类「每分钟要跳字」的文案，用 1 秒 timer 只改
`.stall` / `.expiry` 文本节点（`textContent`），不触发重排。

经验规则：**状态点用 JS 切 class、时间文案用 timer 改 textContent、
整表重绘只留给结构性变化（条目增删/状态迁移）。**

**如果你的机器 GPU 正常**，CSS 动画本来不会有这个代价；若想换回 CSS 动画，
把 `style.css` 里 `.dot.pulse-on` 换成 `@keyframes` 即可，但**建议保留现状**，
因为 JS 方案在所有环境下都更省电。

常驻资源：内存约 390MB（Electron 基线），空闲 CPU < 6%。

---

## 一个环境陷阱

本机环境预设了 `ELECTRON_RUN_AS_NODE=1`。这会让 `electron.exe` 以纯 Node 模式运行，
导致 `require('electron')` 返回 `undefined`、启动时报
`Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。

`scripts/launch.mjs` 和 `scripts/start.ps1` 都会先清除这个变量。
如果你直接双击 `node_modules/electron/dist/electron.exe`，会踩到这个问题。
