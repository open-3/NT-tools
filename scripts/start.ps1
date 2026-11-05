# 启动 Agent Pulse
# 用法：右键 → 使用 PowerShell 运行
#
# 为什么需要这个脚本：本机环境预设了 ELECTRON_RUN_AS_NODE=1，
# 这会让 electron.exe 以纯 Node 模式运行、require('electron') 返回 undefined。
# 脚本先清掉它再启动。

$ErrorActionPreference = 'Stop'
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$appDir = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $exe)) {
    Write-Host '未找到 Electron，请先运行: npm install' -ForegroundColor Red
    exit 1
}

Push-Location $appDir
try {
    & $exe .
} finally {
    Pop-Location
}
