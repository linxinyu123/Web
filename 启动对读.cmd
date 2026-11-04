@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel% equ 0 (
  python serve.py
) else (
  py -3 serve.py
)
if errorlevel 1 pause
