@echo off
REM ---------------------------------------------------------------------------
REM WMS Export — launcher.
REM Starts the tkinter control panel. Uses pythonw.exe if available (no extra
REM console window); falls back to python.exe so first-run errors are visible.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

REM Prefer pythonw (no console). Fall back to python; finally to the launcher.
set "PY="
where pythonw.exe >nul 2>&1 && set "PY=pythonw.exe"
if not defined PY where python.exe  >nul 2>&1 && set "PY=python.exe"
if not defined PY where py.exe       >nul 2>&1 && set "PY=py.exe -3"

if not defined PY (
    echo [run.bat] No Python interpreter found on PATH.
    echo           Install Python 3.10+ from python.org and re-run.
    pause
    exit /b 1
)

REM Launch detached so closing this window doesn't kill the UI.
start "" %PY% "%~dp0wms_ui.py" %*
endlocal
