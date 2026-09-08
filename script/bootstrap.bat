@echo off
REM ===========================================================
REM  Shared first-run bootstrap for the Windows launchers.
REM
REM  Checks Node.js and Python (offering to install them), then
REM  installs the project's own dependencies if they're missing.
REM
REM  Exit 0 = ready to start.  Exit 1 = caller should stop.
REM  The caller has already cd'd to the project root.
REM ===========================================================

REM ---------------- Node.js ----------------
where npm >nul 2>&1
if not errorlevel 1 goto have_node

echo  [X] Node.js was not found - KidSafe needs it to run.
echo.
where winget >nul 2>&1
if errorlevel 1 goto node_manual

echo      Windows Package Manager ^(winget^) can install it for you.
echo      You may see a User Account Control prompt.
echo.
choice /C YN /N /M "     Install Node.js now? [Y/N] "
if errorlevel 2 goto node_manual
echo.
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_manual
echo.
echo  Node.js installed.
echo.
echo  Close this window and double-click the launcher again, so Windows
echo  picks up the updated PATH.
exit /b 1

:node_manual
echo.
echo      Install Node.js ^(the LTS build^) from https://nodejs.org
echo      then double-click the launcher again.
start "" https://nodejs.org/en/download
exit /b 1

:have_node

REM ---------------- Python ----------------
set "PY="
py -3 --version >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if defined PY goto have_python

echo  [X] Python 3 was not found - KidSafe needs it to run.
echo.
where winget >nul 2>&1
if errorlevel 1 goto python_manual

echo      Windows Package Manager ^(winget^) can install it for you.
echo      This installs Python 3.12, which the camera libraries support
echo      ^(the very newest Python often has no MediaPipe build yet^).
echo.
choice /C YN /N /M "     Install Python 3.12 now? [Y/N] "
if errorlevel 2 goto python_manual
echo.
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto python_manual
echo.
echo  Python installed.
echo.
echo  Close this window and double-click the launcher again, so Windows
echo  picks up the updated PATH.
exit /b 1

:python_manual
echo.
echo      Install Python from https://www.python.org/downloads/
echo      and tick "Add Python to PATH" during installation, then
echo      double-click the launcher again.
start "" https://www.python.org/downloads/
exit /b 1

:have_python

REM ------------- Project dependencies -------------
REM  tsx is what every npm script runs through, so checking for it
REM  catches a half-finished "npm install" that would otherwise fail
REM  later with "'tsx' is not recognized".
if not exist "node_modules\tsx\package.json" goto install
if not exist "node_modules\vite\package.json" goto install
if not exist ".setup-complete" goto install
exit /b 0

:install
echo  Installing everything KidSafe needs. This downloads several
echo  hundred MB and can take a few minutes. It only happens once.
echo.
%PY% script\setup.py --venv
if errorlevel 1 (
  echo.
  echo  [X] Setup did not finish. Scroll up to see what failed.
  echo.
  echo      If it failed on mediapipe or torch, your Python is too new.
  echo      Install Python 3.12 and try again:
  echo          winget install --id Python.Python.3.12 -e
  exit /b 1
)
echo done > .setup-complete
echo.
echo  Setup finished.
echo.
exit /b 0
