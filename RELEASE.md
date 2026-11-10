# 发布新版本

远程更新走 electron-updater + GitHub Releases。每次发新版按下面的步骤走一遍。

---

## 前置条件

- 已安装依赖（`npm install`）
- 代码已提交、工作区干净
- 能访问 github.com（本机走 Clash 代理，git 已配好 `http.proxy=7897`）

> 🚨 **最关键的坑（踩过两次）**：`dist/` 被 `.gitignore` 排除，
> **不进版本控制**。所以「源码改了 → 提交了」≠「dist 里的产物是最新的」。
> 每次发布前必须 `npm run build`，否则打包进 installer 的是旧的 dist，
> 客户端「升级」后还是旧代码（曾因此把带 bug 的 0.1.1 发出去，只能再升 0.1.2 补发）。

---

## 一、改版本号

编辑 `package.json` 的 `version`，遵循 semver：

```
0.1.0  →  0.1.1   (修复 bug)
0.1.0  →  0.2.0   (新功能)
0.1.0  →  1.0.0   (大版本/破坏性变更)
```

改完提交：

```bash
git add package.json package-lock.json
git commit -m "chore: 版本号升级到 0.1.1"
```

> `package-lock.json` 里的 `version` 字段也要同步（`npm install` 或手动改，
> 保证 lock 里的版本和 version 字段一致，否则 npm 会警告）。

---

## 二、打包 + 发布到 GitHub Releases

**方式 A：一条命令（推荐，需要 GitHub Token）**

```powershell
$env:GH_TOKEN = "github_pat_xxxxxxxxxxxxxxxx"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run build   # ← 必须先 build，把最新源码编译进 dist

# 下面三个变量是本地打包的固定条件（见下方「7za shim 说明」）
$env:HTTP_PROXY  = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:USE_SYSTEM_7ZA = "true"
$env:PATH = "D:\tools\7za-shim;$env:PATH"

npx electron-builder --win --x64 --publish always
```

> ⚠️ **必须 `npm run build` 后再 `electron-builder`**。
> dist 不进 git，直接跑 electron-builder 会打进旧代码（见「前置条件」的坑）。
>
> ⚠️ **不要加 `--config.win.signAndEditExecutable=false`**（旧结论，已作废）。
> 这个 flag 会连同禁用 rcedit 的 `--set-icon` 步骤，导致 exe 内嵌图标
> **永远是 Electron 默认 atom 图**，改 `build/icon.ico` 无效。本机无签名证书时，
> electron-builder 会在 `no signing info identified, signing is skipped` 优雅跳过签名，
> 但 rcedit（嵌入图标 + 版本元数据）仍会正常执行，这正是我们需要的。

`--publish always` 会自动：
1. 构建 NSIS installer
2. 生成 latest.yml + .blockmap
3. 上传到 GitHub Releases，创建 tag（如 `v0.1.1`）

**方式 B：手动发布（没有 Token 时）**

1. 本地打包（不发布）：
   ```powershell
   npm run build
   $env:HTTP_PROXY  = "http://127.0.0.1:7890"
   $env:HTTPS_PROXY = "http://127.0.0.1:7890"
   $env:USE_SYSTEM_7ZA = "true"
   $env:PATH = "D:\tools\7za-shim;$env:PATH"
   npx electron-builder --win --x64
   ```
2. 到 GitHub 仓库 → Releases → Draft a new release
3. Tag 填 `v0.1.1`（**必须带 v 前缀**，electron-updater 按这个找）
4. 上传 `release/` 里的三个文件：
   - `AgentPulse-Setup-0.1.1.exe`
   - `latest.yml`
   - `AgentPulse-Setup-0.1.1.exe.blockmap`
5. 发布

> 关键：**三个文件必须都在同一个 Release 的同一层级**。electron-updater
> 检查更新时读 `latest.yml`，里面的 `url` 是相对路径，指向同目录的 exe 和 blockmap。

---

## 三、⚠️ 把 Draft 转为正式发布（必做，最容易漏）

electron-builder 的 `--publish always` 默认创建的是 **Draft（草稿）** Release，
草稿状态下客户端**下载不到 latest.yml**（404），等于没发布。

发完版后，必须去 GitHub 把 Draft 转成正式发布：

1. 打开 https://github.com/open-3/NT-tools/releases
2. 找到刚建的 `v0.1.1`（标着 **Draft**）
3. 点它 → 编辑 → 底部 **「Publish release」** 按钮

或走 API（需要 Token）：

```bash
# 找到 draft release 的 id 后：
$h = @{ Authorization = "Bearer $env:GH_TOKEN"; "User-Agent" = "agent-pulse" }
$rels = Invoke-RestMethod "https://api.github.com/repos/open-3/NT-tools/releases" -Headers $h
$rel = $rels | Where-Object { $_.tag_name -eq "v0.1.1" }
$body = @{ draft = $false } | ConvertTo-Json
Invoke-RestMethod "https://api.github.com/repos/open-3/NT-tools/releases/$($rel.id)" -Method Patch -Headers $h -Body $body -ContentType "application/json"
```

> 验证是否生效：浏览器直接开
> `https://github.com/open-3/NT-tools/releases/download/v0.1.1/latest.yml`
> 能下载到内容（HTTP 200）就说明正式发布了。

---

## 四、验证

旧版本客户端启动后（8 秒静默检查或托盘「检查更新」），会：

1. 检测到新版本 → 弹「发现新版本 0.1.1」
2. 点「立即更新」→ 下载（走 blockmap 增量）
3. 下载完 → 提示重启安装
4. 重启后自动装新版

想手动验一次：装一个旧版 installer，改个假的大版本号发布，看旧版能否检测到。

---

## 常见问题

### Q: 「检查更新」报 not found / 404？

说明 GitHub Releases 里**还没有对应的 tag**。electron-updater 找的是
`https://github.com/open-3/NT-tools/releases/download/v<version>/latest.yml`。
确认 Release 的 tag 版本号、latest.yml 都已上传。

### Q: 更新下载后没自动装？

electron-updater 的 `quitAndInstall` 依赖 AppId（`com.agentpulse.app`）稳定。
若改过 `appId`，旧版无法识别新版 installer，会静默失败——不要改 appId。

### Q: 开发态（npm start）点检查更新？

开发态 `!app.isPackaged` 直接跳过，返回「开发模式下不检查更新」，
不会去连 GitHub。只在安装版里真正检查。

### Q: 为什么从 portable 改成了 installer？

portable 每次运行解压到临时目录，无法原地更新（更新后重启就丢）。
installer 有固定安装路径（`%LOCALAPPDATA%\Programs\agent-pulse`），
electron-updater 才能做增量替换。这是换发行形态的根本原因。

### Q: 客户端提示「发现新版本 0.1.x」，但当前版本已经是 0.1.x？

两种情况，分别排查：

1. **发包时漏了 `npm run build`**（最常见）。dist 进不了 git，
   直接 electron-builder 会打进旧代码，客户端「升级」后还是旧逻辑。
   解法：重新 `npm run build` 后升版本号（如 0.1.2）重新发布一次。

2. **代码 bug**：updater 判断逻辑用错了字段。electron-updater 的
   `checkForUpdates()` 永远返回非 null 对象，是否更新要看
   `result.isUpdateAvailable`，不能拿「返回是否 null」来判断。

升级到修复版之后，再点检查更新才会正确返回「已是最新版本」。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/main/updater.ts` | 更新逻辑（检查/下载/安装/进度） |
| `package.json` 的 `build.publish` | 更新源仓库配置 |
| `package.json` 的 `build.nsis` | 安装包配置（oneClick、快捷方式） |
| `scripts/build-main.mjs` | electron-updater 设为 external |
| `dist/` | 打包产物，**被 gitignore**，发布前必须重新 build |
| `release/` | electron-builder 输出（exe + latest.yml + blockmap） |

---

## 7za shim 说明（winCodeSign 符号链接修复）

electron-builder 打包时会下载 `winCodeSign-2.6.0.7z` 解压出 rcedit。
该 .7z 里 darwin 的 `libcrypto.dylib`/`libssl.dylib` 是 **符号链接**，
Windows 无权限创建（普通用户无 `SeCreateSymbolicLinkPrivilege`），
7za 解压报 `Cannot create symbolic link : 客户端没有所需的特权` 且 exit 2，
导致 electron-builder 判下载失败、反复重试（每次换随机目录名）。

Go 下载器 `app-builder.exe` 通过 `SZA_PATH` 定位 7za 并**强制附加 `-snld`**（创建符号链接）。
解法是做一个 **7za.exe 转发 shim**，把参数转发给真实 7za 并在**末尾追加 `-snl-`**
（`-snl-` 排最后会覆盖之前的 `-snld`，跳过符号链接，剩余真实文件正常解压）。

已落地（`D:\tools\7za-shim\`）：

- `7za-real.exe`：从 `node_modules\7zip-bin\win\x64\7za.exe` 复制的真实 7za。
- `7za.exe`：C# 转发 shim（源码 `shim.cs`），用 `csc.exe` 编译，转发 args 并追加 `-snl-`。
- 打包时设 `USE_SYSTEM_7ZA=true` 让 node 端 `getPath7za()` 返回裸 `"7za"`，
  再把 `D:\tools\7za-shim` 前置进 `PATH`，Go 下载器和 NSIS 阶段就能找到 shim。

> 一旦 winCodeSign 解压成功，会以稳定名 `winCodeSign-2.6.0` 缓存，
> 之后打包不再触发下载，无需重复这些步骤（除非清空 electron-builder 缓存）。
