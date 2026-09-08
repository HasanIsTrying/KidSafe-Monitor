@echo off
REM ===========================================================
REM  KidSafe - REAL mode (Windows)
REM
REM  Just double-click this file.
REM  The first run checks for Node.js and Python (offering to
REM  install them) and downloads everything else. Later runs
REM  go straight to starting the app.
REM
REM  Real mode needs auth_config.json (SMS + push credentials).
REM  Without it, use Start-Demo.bat instead.
REM ===========================================================

cd /d "%~dp0"
title KidSafe

echo.
echo  ===========================================
echo    KidSafe
echo  ===========================================
echo.

call script\bootstrap.bat
if errorlevel 1 goto finish

REM --- Real mode needs credentials --------------------------
if exist "auth_config.json" goto start
echo  [!] auth_config.json was not found.
echo.
echo      Real mode needs SMS and push credentials to send login
echo      codes and alerts. Copy auth_config.example.json to
echo      auth_config.json and fill in your own values.
echo      See section 2 of README.md.
echo.
echo      Without it the app falls back to the demo account.
echo.
echo      Starting anyway in 5 seconds - close this window to cancel.
timeout /t 5 >nul

:start
echo  Starting KidSafe...
echo.
echo  When it says "serving on port", open:  http://127.0.0.1:5050
echo  A public HTTPS link is printed too - use that one on a phone,
echo  because push notifications do not work over localhost.
echo.
echo  Press Ctrl+C in this window to stop.
echo.
call npm run launch

:finish
echo.
pause
