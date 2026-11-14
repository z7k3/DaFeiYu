# package-portable.ps1 —— 一键生成"通用便携版"（给别人开箱即用 / 发 Release）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-portable.ps1 [-App ...] [-OutDir D:\WhaleGirl\dist] [-Zip]
# 产物：OutDir\whale_girl-<版本>-portable\ 目录（-Zip 再压同名 .zip）
# 原则：永远从「仓库最新代码 + APP 运行目录的 runtime」现生成，不做手工维护的拷贝——
#       手工拷贝必过期。剔除与净化规则固定写死在本脚本，谁打包都一样。

param(
    [string]$App = 'D:\WhaleGirl\WhaleGirl',
    [string]$OutDir = 'D:\WhaleGirl\dist',
    [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $Repo 'server.js'))) { Write-Host 'ERR 仓库根不对'; exit 1 }
if (-not (Test-Path (Join-Path $App 'runtime'))) { Write-Host 'ERR APP 目录没有 runtime/（打不了便携包）'; exit 1 }
# PS5.1 的 Get-Content 默认按 ANSI 读，UTF-8 中文会炸 JSON——用包内 node 读版本最稳
$Version = (& (Join-Path $App 'runtime\node.exe') -e "console.log(require(process.argv[1]).version)" (Join-Path $Repo 'package.json') | Out-String).Trim()
$Name = "whale_girl-$Version-portable"
$Dst = Join-Path $OutDir $Name
if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- 1) 复制：程序走仓库（保证最新），runtime/声卡驱动/资源走 APP 目录 ----
foreach ($dir in @('bridge', 'config', 'docs', 'examples', 'scripts', 'src', 'assets')) {
    if (Test-Path (Join-Path $Repo $dir)) {
        robocopy (Join-Path $Repo $dir) (Join-Path $Dst $dir) /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy $dir 失败" }; $global:LASTEXITCODE = 0
    }
}
robocopy (Join-Path $App 'runtime') (Join-Path $Dst 'runtime') /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'robocopy runtime 失败' }; $global:LASTEXITCODE = 0
if (Test-Path (Join-Path $App 'VB-CABLE虚拟声卡')) { robocopy (Join-Path $App 'VB-CABLE虚拟声卡') (Join-Path $Dst 'VB-CABLE虚拟声卡') /E /NFL /NDL /NJH /NJS /NP | Out-Null; $global:LASTEXITCODE = 0 }
foreach ($f in @('server.js', 'package.json', 'config.example.json', 'release-manifest.json', 'WhaleLauncher.exe', 'LICENSE', 'NOTICE.md', 'README.md')) {
    $p = Join-Path $Repo $f; if (-not (Test-Path $p)) { $p = Join-Path $App $f }
    if (Test-Path $p) { Copy-Item $p (Join-Path $Dst $f) -Force }
}

# ---- 2) 净化 config.json：保留行为调优，剔除一切本机身份与密钥 ----
$nodeExe = Join-Path $Dst 'runtime\node.exe'
$sanitize = @'
const fs = require('fs');
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const empty = v => Array.isArray(v) ? [] : '';
if (cfg.persona && cfg.persona.master) { cfg.persona.master.names = empty(cfg.persona.master.names); cfg.persona.master.wxids = empty(cfg.persona.master.wxids); }
if (cfg.care) cfg.care.whitelist = empty(cfg.care.whitelist);
if (cfg.wechat) { cfg.wechat.account = ''; cfg.wechat.windowHwnd = 0; }
if (cfg.voice) cfg.voice.apiKey = '';
if (cfg.deepseek) cfg.deepseek.apiKey = '';
if (cfg.vision) cfg.vision.apiKey = '';
if (cfg.admin) cfg.admin.spell = '';
const token = () => Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
if (cfg.gateway && cfg.gateway.wechat) cfg.gateway.wechat.inboundToken = token();
if (cfg.gateway && cfg.gateway.douyin) cfg.gateway.douyin.inboundToken = token();
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
'@
$tmp = Join-Path $env:TEMP 'whale-sanitize.js'
Set-Content -Path $tmp -Value $sanitize -Encoding UTF8
& $nodeExe $tmp (Join-Path $Dst 'config.json') (Join-Path $App 'config.json')
if ($LASTEXITCODE -ne 0) { throw 'config 净化失败' }
Remove-Item $tmp -Force

# ---- 3) 移植说明（版本号动态） ----
$readme = @"
鲸鲸 WhaleGirl $Version 通用便携版
====================================
程序从源码仓库 $((Get-Date).ToString('yyyy-MM-dd')) 现场打包，已剔除：
  密钥（模型/语音识别）、微信账号绑定、主人名单、全部聊天记忆/知识库/日志/表情包。
保留：全部行为调优（群聊策略、后台静默发送、检索管道等）与随包运行时。

【新电脑使用】
1. 文件夹放任意盘，双击 WhaleLauncher.exe
2. 启动器「设置」填自己的模型 Key（DeepSeek/智谱免费版均可）
3. 微信以管理员身份运行并登录；启动器「微信桥接」页选账号、启动桥接
4. 要发语音：先装包内「VB-CABLE虚拟声卡」里的驱动，再按启动器语音页配置
【常见问题】
- 桥接报缺 DLL：装微软 VC++ x64 运行库
- 天气城市在 config.json 的 websearch.city 改，存盘即热生效
"@
Set-Content -Path (Join-Path $Dst '移植说明-必读.txt') -Value $readme -Encoding UTF8

# ---- 4) 冒烟自检（包内 node 跑 doctor，验完删掉生成的 data/） ----
Push-Location $Dst
& ".\runtime\node.exe" server.js --doctor *> $null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'doctor 冒烟失败' }
Pop-Location
if (Test-Path (Join-Path $Dst 'data')) { Remove-Item (Join-Path $Dst 'data') -Recurse -Force }

$files = (Get-ChildItem $Dst -Recurse -File).Count
$mb = [math]::Round(((Get-ChildItem $Dst -Recurse -File | Measure-Object Length -Sum).Sum)/1MB, 1)
Write-Host ("OK $Name 生成完毕：$files 个文件 / $mb MB（doctor 冒烟通过）")

if ($Zip) {
    $zipPath = Join-Path $OutDir "$Name.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$Dst\*" -DestinationPath $zipPath -CompressionLevel Optimal
    Write-Host ("OK 压缩包：" + [math]::Round((Get-Item $zipPath).Length/1MB,1) + " MB → $zipPath")
}
