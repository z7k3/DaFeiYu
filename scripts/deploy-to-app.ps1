# deploy-to-app.ps1 —— 把本仓库的程序文件同步到鲸鲸 APP 目录。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-to-app.ps1 [-App 'D:\WhaleGirl\WhaleGirl'] [-BackupData]
# 只覆盖程序文件（src/bridge/examples/server.js/assets），data/ 与 runtime/ 永远不碰；
# -BackupData 会先把 config.json + data/memory + data/kb 快照到 data-backup-<时间戳>。

param(
    [string]$App = 'D:\WhaleGirl\WhaleGirl',
    [switch]$BackupData
)
$ErrorActionPreference = 'Stop'
$Source = 'D:\WhaleGirl\source code\whale_girl-4.0.8.2\whale_girl-4.0.8.2'
if ($PSScriptRoot) { $Source = Split-Path $PSScriptRoot -Parent }
if (-not (Test-Path (Join-Path $Source 'server.js'))) { Write-Host '❌ 找不到源码根目录'; exit 1 }
if (-not (Test-Path (Join-Path $App 'server.js'))) { Write-Host '❌ APP 目录不对（没有 server.js）'; exit 1 }

if ($BackupData) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $App ("data-backup-" + $stamp)
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    foreach ($item in @('config.json', 'data\memory', 'data\kb')) {
        $srcItem = Join-Path $App $item
        if (Test-Path $srcItem) {
            $dstItem = Join-Path $backup $item
            New-Item -ItemType Directory -Force -Path (Split-Path $dstItem) | Out-Null
            Copy-Item $srcItem $dstItem -Recurse -Force
        }
    }
    Write-Host ('📦 已备份关键数据 → ' + $backup)
}

$changed = 0
# src/ 全量（源码树里没有编译产物，直接整目录镜像）
robocopy (Join-Path $Source 'src') (Join-Path $App 'src') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -le 7) { $changed++ } else { Write-Host '❌ robocopy src 失败'; exit 1 }
# bridge/ 只拷 .py（__pycache__ 是运行产物不碰）
Get-ChildItem -LiteralPath (Join-Path $Source 'bridge') -Filter '*.py' | ForEach-Object {
    Copy-Item $_.FullName (Join-Path ($App + '\bridge') $_.Name) -Force
    $changed++
}
# examples/ 与 server.js、assets/
Copy-Item (Join-Path $Source 'server.js') (Join-Path $App 'server.js') -Force; $changed++
if (Test-Path (Join-Path $Source 'examples')) { robocopy (Join-Path $Source 'examples') (Join-Path $App 'examples') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
if (Test-Path (Join-Path $Source 'assets')) { robocopy (Join-Path $Source 'assets') (Join-Path $App 'assets') /E /NFL /NDL /NJH /NJS /NP | Out-Null }

Write-Host ('✅ 同步完成：src 镜像 + bridge ' + (Get-ChildItem -LiteralPath (Join-Path $Source 'bridge') -Filter '*.py').Count + ' 个 .py + examples/server.js/assets')
Write-Host '⚠️  需要重启内核与微信桥接后才生效（启动器里点「重启」）。'
