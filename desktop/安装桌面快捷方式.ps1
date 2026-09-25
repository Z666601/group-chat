# 在多智能体群聊的原项目中安装「桌面 APP」
# 用法：powershell -ExecutionPolicy Bypass -File desktop\安装桌面快捷方式.ps1
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$AppDir = Join-Path $Desktop '群聊'
$IconPath = Join-Path $ROOT 'desktop\群聊.ico'

Write-Host "项目目录 : $ROOT"
Write-Host "桌面目录 : $Desktop"

# ── 1) 生成图标（ICO 内嵌 PNG，256x256）──────────────
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 深色圆角方块底
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 24, 26))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 44
$path.AddArc(8, 8, $r, $r, 180, 90)
$path.AddArc(248 - $r, 8, $r, $r, 270, 90)
$path.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90)
$path.AddArc(8, 248 - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($bg, $path)

# 白色对话气泡
$bubble = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 250, 250, 250))
$g.FillRectangle($bubble, 56, 74, 144, 96)
$tail = @(
  (New-Object System.Drawing.Point 92, 170),
  (New-Object System.Drawing.Point 92, 202),
  (New-Object System.Drawing.Point 126, 170)
)
$g.FillPolygon($bubble, $tail)

# 气泡里的三行「消息」
$line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 24, 26))
$g.FillRectangle($line, 76, 96, 104, 12)
$g.FillRectangle($line, 76, 118, 76, 12)
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 118, 110))
$g.FillRectangle($accent, 76, 140, 48, 12)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$fs = [System.IO.File]::Create($IconPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]1)          # count
$bw.Write([byte]0)            # width 256
$bw.Write([byte]0)            # height 256
$bw.Write([byte]0)            # palette
$bw.Write([byte]0)            # reserved
$bw.Write([UInt16]1)          # planes
$bw.Write([UInt16]32)         # bpp
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)         # offset
$bw.Write($png)
$bw.Close()
Write-Host "已生成图标 : $IconPath"

# ── 2) 桌面文件夹 + 说明 ─────────────────────────────
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$readme = @'
多智能体群聊 · 使用说明
========================

【启动】双击本目录里的「启动群聊.cmd」
        （或直接双击桌面上的「群聊」快捷方式）
        会自动完成：启动服务 → 准备讨论组 → 拉起 Agent → 打开应用窗口

【使用】默认账号：app_owner  密码：app_owner_pass_123
        进入后可建群、邀请成员、实时收发消息；
        多智能体讨论组里已经坐好 AutoClaw / Hermes / Ekko Studio / ZCode 与本机演示大脑。
        点右上角「成员」，每个 Agent 下面都有「模型」下拉栏，可单独指定它用哪个大模型。

【停止】双击「停止群聊.cmd」。数据保存在项目的 data 目录，不会丢。

【地址】浏览器也可直接访问 http://127.0.0.1:8787

【打不开怎么办】若双击无反应，查看项目 data\launcher.log；
        手动运行 desktop\启动群聊.cmd 可以看到详细输出。

【Agent 未作答？】每个 Agent 的接入条件见项目 docs\07-multi-agent.md
'@
Set-Content -Path (Join-Path $AppDir '使用说明.txt') -Value $readme -Encoding UTF8

$wrappers = @{
  '启动群聊.cmd' = (Join-Path $ROOT 'desktop\start.ps1')
  '停止群聊.cmd' = (Join-Path $ROOT 'desktop\stop-app.ps1')
}
foreach ($name in $wrappers.Keys) {
  $dest = Join-Path $AppDir $name
  $scriptPath = $wrappers[$name]
  # 内容必须 ASCII-only：纯中文 Windows 的 cmd.exe 会按 GBK 解析批处理，含中文的 UTF-8 .cmd 会被撕碎
  $body = "@echo off`r`nrem ASCII-only shim`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"`r`nexit /b %errorlevel%`r`n"
  [System.IO.File]::WriteAllText($dest, $body, [System.Text.Encoding]::ASCII)
}
Write-Host "已创建桌面文件夹 : $AppDir"

# ── 3) 桌面快捷方式 ──────────────────────────────────
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $Desktop '群聊.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $ROOT 'desktop\启动群聊.cmd'
$lnk.WorkingDirectory = $ROOT
$lnk.IconLocation = "$IconPath,0"
$lnk.Description = '多智能体群聊 · 一键启动'
$lnk.WindowStyle = 7
$lnk.Save()
Write-Host "已创建桌面快捷方式 : $lnkPath"

Write-Host ''
Write-Host '安装完成：桌面已出现「群聊」快捷方式与「群聊」文件夹。' -ForegroundColor Green
