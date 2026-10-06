@echo off
setlocal enabledelayedexpansion
title 下载 ComfyUI 桥接插件所需的模型

echo ============================================================
echo   ComfyUI 桥接插件 - 模型一键下载
echo ============================================================
echo.
echo   要下载两个模型（共约 488 MB）：
echo     1. birefnet.safetensors   424 MB   AI 去背景
echo     2. RealESRGAN_x4plus.pth   64 MB   AI 放大超分
echo.
echo   下载源：ModelScope（国内，实测 4~5 MB/s）
echo   预计总耗时：约 2 分钟
echo.

rem ================= 找 ComfyUI 目录 =================
set "COMFY="
for %%D in (
  "C:\ComfyUI\ComfyUI_windows_portable"
  "D:\ComfyUI\ComfyUI_windows_portable"
  "E:\ComfyUI\ComfyUI_windows_portable"
  "C:\ComfyUI"
  "D:\ComfyUI"
  "E:\ComfyUI"
  "%USERPROFILE%\ComfyUI\ComfyUI_windows_portable"
  "%USERPROFILE%\Desktop\ComfyUI\ComfyUI_windows_portable"
  "%USERPROFILE%\Downloads\ComfyUI_windows_portable"
) do (
  if not defined COMFY (
    if exist "%%~D\ComfyUI\main.py" set "COMFY=%%~D"
    if exist "%%~D\main.py" set "COMFY=%%~D"
  )
)

if not defined COMFY (
  echo ------------------------------------------------------------
  echo   没有自动找到 ComfyUI
  echo ------------------------------------------------------------
  echo.
  echo   请用鼠标把 ComfyUI 文件夹从资源管理器拖到这个窗口里，
  echo   然后按回车。（或者手动输入路径）
  echo.
  echo   正确的文件夹里应该有这几个东西：
  echo       ComfyUI\   python_embeded\   run_nvidia_gpu.bat
  echo.
  set /p COMFY=  路径: 
  set "COMFY=!COMFY:"=!"
)

if not exist "!COMFY!\main.py" (
  if not exist "!COMFY!\ComfyUI\main.py" (
    echo.
    echo   [错误] 这个目录里找不到 main.py，不像是 ComfyUI：
    echo          !COMFY!
    echo.
    pause
    exit /b 1
  )
)
if exist "!COMFY!\ComfyUI\main.py" set "COMFY=!COMFY!\ComfyUI"

echo.
echo ============================================================
echo   找到 ComfyUI：
echo   !COMFY!
echo ============================================================
echo.
echo   模型会下载到这两个位置：
echo     !COMFY!\models\background_removal\birefnet.safetensors
echo     !COMFY!\models\upscale_models\RealESRGAN_x4plus.pth
echo.
pause

if not exist "!COMFY!\models\background_removal" mkdir "!COMFY!\models\background_removal" 2>nul
if not exist "!COMFY!\models\upscale_models" mkdir "!COMFY!\models\upscale_models" 2>nul

where curl >nul 2>&1
if errorlevel 1 (
  echo   [错误] 系统里没有 curl 命令。
  echo          Windows 10 1803 以上都自带，你的可能太老了。
  echo          可以手动下载，地址见 安装说明.md
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   进度条怎么看
echo ============================================================
echo.
echo   curl 会输出这样的表格，重点看这几列：
echo.
echo       %%  Total    %%  Received  ...   Time Left   Speed
echo      42  423M    42  178M      ...   0:01:02    4305k
echo      ^^            ^^                        ^^
echo      ^|             ^|                        ^|
echo      ^|             ^|                        ^+-- 下载速度
echo      ^|             ^+-- 已下载多少
echo      ^+-- 完成百分比
echo.
echo   或者更简单：打开那个文件夹，看文件大小在不在涨。
echo.
pause

rem ================= 下载 1 =================
echo.
echo ------------------------------------------------------------
echo   [1/2] 正在下载  birefnet.safetensors  （424 MB）
echo         约 1 分 40 秒
echo ------------------------------------------------------------
echo.
set "F1=!COMFY!\models\background_removal\birefnet.safetensors"
if exist "!F1!" (
  echo   这个文件已经存在，跳过下载。
  echo   如果你想重新下，先手动删掉它再运行本脚本。
) else (
  curl -L --fail --retry 5 --retry-delay 3 -C - -o "!F1!" ^
    "https://modelscope.cn/api/v1/models/Comfy-Org/BiRefNet/repo?Revision=master&FilePath=background_removal/birefnet.safetensors"
  if errorlevel 1 (
    echo.
    echo   [错误] 下载失败。请检查网络后重新运行本脚本
    echo          （已经下了一部分，重跑会接着下，不会从头开始）
    echo.
    pause
    exit /b 1
  )
)
call :CHECKSIZE "!F1!" 400 "birefnet.safetensors"

rem ================= 下载 2 =================
echo.
echo ------------------------------------------------------------
echo   [2/2] 正在下载  RealESRGAN_x4plus.pth  （64 MB）
echo         约 15 秒
echo ------------------------------------------------------------
echo.
set "F2=!COMFY!\models\upscale_models\RealESRGAN_x4plus.pth"
if exist "!F2!" (
  echo   这个文件已经存在，跳过下载。
) else (
  curl -L --fail --retry 5 --retry-delay 3 -C - -o "!F2!" ^
    "https://modelscope.cn/api/v1/models/AI-ModelScope/RealESRGAN_x4plus/repo?Revision=master&FilePath=RealESRGAN_x4plus.pth"
  if errorlevel 1 (
    echo.
    echo   [错误] 下载失败。
    echo.
    pause
    exit /b 1
  )
)
call :CHECKSIZE "!F2!" 50 "RealESRGAN_x4plus.pth"

echo.
echo ============================================================
echo   全部完成
echo ============================================================
echo.
echo   文件位置：
echo     !F1!
echo     !F2!
echo.
echo   接下来请：
echo     1. 双击 ComfyUI 目录里的  run_nvidia_gpu.bat  （N 卡）
echo                              或  run_amd_gpu.bat     （A 卡）
echo     2. 等黑窗口出现 "To see the GUI go to: http://localhost:8188"
echo     3. 保持那个窗口开着，回到 Photoshop 点【测试连接】
echo.
echo   提示：如果双击启动脚本闪一下就没了，说明 ComfyUI 装错了地方。
echo.
pause
exit /b 0

rem ================= 校验文件大小 =================
:CHECKSIZE
set "FILE=%~1"
set "MINMB=%~2"
set "NAME=%~3"
if not exist "%FILE%" (
  echo.
  echo   [错误] 文件没下下来：%NAME%
  echo.
  pause
  exit /b 1
)
for %%A in ("%FILE%") do set "SZ=%%~zA"
set /a "SZMB=SZ/1048576"
echo.
if %SZMB% GEQ %MINMB% (
  echo   [OK] %NAME%  下载完成，大小 %SZMB% MB
) else (
  echo   [警告] %NAME%  只有 %SZMB% MB，看起来没下完（应该约 %MINMB% MB 以上）
  echo          请重新运行本脚本，会自动接着下。
)
exit /b 0
