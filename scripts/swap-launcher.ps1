# swap-launcher.ps1 —— 把仓库根的新版 WhaleLauncher.exe 换进 APP 目录（需先关闭启动器）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\swap-launcher.ps1
# 源永远是仓库根的 WhaleLauncher.exe（上游合并自带）；旧版自动备份为 WhaleLauncher-旧版本.exe
$ErrorActionPreference = 'Stop'
$app = 'D:\WhaleGirl\WhaleGirl'
$repo = Split-Path $PSScriptRoot -Parent
$staged = Join-Path $repo 'WhaleLauncher.exe'
$target = Join-Path $app 'WhaleLauncher.exe'
if (-not (Test-Path $staged)) { Write-Host 'ERR 仓库根没有 WhaleLauncher.exe'; exit 1 }
if (-not (Test-Path $target)) { Write-Host 'ERR APP 目录不对（没有 WhaleLauncher.exe）'; exit 1 }
$running = Get-Process WhaleLauncher -ErrorAction SilentlyContinue
if ($running) { Write-Host 'ERR 启动器还在运行，请先在托盘/任务栏退出启动器再执行本脚本'; exit 1 }
$newV = (Get-Item $staged).VersionInfo.ProductVersion
$oldV = (Get-Item $target).VersionInfo.ProductVersion
if ($newV -eq $oldV) { Write-Host "OK 已经是 $newV，不用换"; exit 0 }
Copy-Item $target (Join-Path $app ("WhaleLauncher-" + $oldV + ".exe")) -Force
Copy-Item $staged $target -Force
Write-Host ('OK 启动器已从 ' + $oldV + ' 更新到 ' + $newV + '（旧版备份为 WhaleLauncher-' + $oldV + '.exe），现在可以重新打开鲸鲸了')
