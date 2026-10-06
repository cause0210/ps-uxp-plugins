@echo off
setlocal enabledelayedexpansion
title 下载 ComfyUI 桥接插件所需的模型

echo ============================================================
echo   ComfyUI 桥接插件 - 模型一键下载
echo ============================================================
echo.
echo   需要下载两个模型（共约 488 MB）：
echo     1. birefnet.safetensors   424 MB   用于 AI 去背景
echo     2. RealESRGAN_x4plus.pth   64 MB   用于 AI 放大超分
echo.
echo   下载源是 ModelScope（国内，实测 4~5 MB/s）
echo.

rem ---------- 找 ComfyUI 目录 ----------
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
  echo   没有自动找到 ComfyUI。
  echo.
  echo   请把 ComfyUI 文件夹直接拖到本窗口，然后按回车：
  set /p COMFY=  路径: 
  set "COMFY=!COMFY:"=!"
)

if not exist "!COMFY!\main.py" (
  if not exist "!COMFY!\ComfyUI\main.py" (
    echo.
    echo   [错误] 这个目录里没有 main.py，不像是 ComfyUI：
    echo          !COMFY!
    echo.
    pause
    exit /b 1
  )
)
if exist "!COMFY!\ComfyUI\main.py" set "COMFY=!COMFY!\ComfyUI"

echo.
echo   ComfyUI 目录: !COMFY!
echo.

if not exist "!COMFY!\models\background_removal" mkdir "!COMFY!\models\background_removal"
if not exist "!COMFY!\models\upscale_models" mkdir "!COMFY!\models\upscale_models"

rem ---------- 检查 curl ----------
where curl >nul 2>&1
if errorlevel 1 (
  echo   [错误] 系统里没有 curl。Windows 10 1803 以上应该自带。
  echo          可以手动下载，地址见 安装说明.md
  echo.
  pause
  exit /b 1
)

echo ------------------------------------------------------------
echo   [1/2] 下载 BiRefNet（424 MB，约 2 分钟）
echo ------------------------------------------------------------
set "F1=!COMFY!\models\background_removal\birefnet.safetensors"
if exist "!F1!" (
  echo   已存在，跳过。要重新下载请先删除该文件。
) else (
  curl -L --fail --retry 5 --retry-delay 3 -C - -o "!F1!" ^
    "https://modelscope.cn/api/v1/models/Comfy-Org/BiRefNet/repo?Revision=master&FilePath=background_removal/birefnet.safetensors"
  if errorlevel 1 (
    echo.
    echo   [错误] 下载失败。请检查网络，或手动下载（见 安装说明.md）
    echo.
    pause
    exit /b 1
  )
)

echo.
echo ------------------------------------------------------------
echo   [2/2] 下载 RealESRGAN（64 MB，约 15 秒）
echo ------------------------------------------------------------
set "F2=!COMFY!\models\upscale_models\RealESRGAN_x4plus.pth"
if exist "!F2!" (
  echo   已存在，跳过。
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

echo.
echo ============================================================
echo   下载完成
echo ============================================================
echo.
echo   文件位置：
echo     !F1!
echo     !F2!
echo.
dir /B "!COMFY!\models\background_removal"
dir /B "!COMFY!\models\upscale_models"
echo.
echo   接下来：
echo     1. 启动 ComfyUI（run_nvidia_gpu.bat 或 run_cpu.bat）
echo     2. 等出现 "To see the GUI go to: http://localhost:8188"
echo     3. 回到 Photoshop，点插件里的【测试连接】
echo.
pause
