# swap-launcher.ps1 —— 把 4.1.0 启动器换成正式文件（需先关闭启动器）
# 用法：右键「以管理员身份运行」或 powershell -File scripts\swap-launcher.ps1
$ErrorActionPreference = 'Stop'
$app = 'D:\WhaleGirl\WhaleGirl'
$staged = Join-Path $app 'WhaleLauncher-4.1.0.exe'
$target = Join-Path $app 'WhaleLauncher.exe'
if (-not (Test-Path $staged)) { Write-Host '❌ 找不到 WhaleLauncher-4.1.0.exe（可能已替换过）'; exit 1 }
$running = Get-Process WhaleLauncher -ErrorAction SilentlyContinue
if ($running) { Write-Host '❌ 启动器还在运行，请先在托盘/任务栏退出启动器再执行本脚本'; exit 1 }
Copy-Item $staged $target -Force
$v = (Get-Item $target).VersionInfo.ProductVersion
Remove-Item $staged -Force
Write-Host ('✅ 启动器已更新到 ' + $v + '，现在可以重新打开鲸鲸了')
