@echo off
REM ===========================================================
REM  KidSafe - DEMO mode (Windows)
REM
REM  Just double-click this file.
REM  The first run checks for Node.js and Python (offering to
REM  install them) and downloads everything else. Later runs
REM  go straight to starting the app.
REM ===========================================================

cd /d "%~dp0"
title KidSafe - Demo

echo.
echo  ===========================================
echo    KidSafe - Demo mode
echo  ===========================================
echo.

call script\bootstrap.bat
if errorlevel 1 goto finish

echo  Starting KidSafe in demo mode...
echo.
echo  When it says "serving on port", open:  http://127.0.0.1:5050
echo  Then click "Try the demo - no phone needed".
echo.
echo  Press Ctrl+C in this window to stop.
echo.
call npm run demo

:finish
echo.
pause
