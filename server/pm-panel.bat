@echo off
REM PM Panel server control script (Windows)
REM Usage: pm-panel.bat {start|stop|restart|status}

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

if "%PM_PANEL_PORT%"=="" set "PM_PANEL_PORT=4000"
set "LOG_FILE=%SCRIPT_DIR%pm-panel.log"
set "PID_FILE=%SCRIPT_DIR%.pm-panel.pid"

REM Resolve node binary
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node not found in PATH.
  popd >nul
  exit /b 1
)

set "ACTION=%~1"
if /I "%ACTION%"=="start"   goto :start
if /I "%ACTION%"=="stop"    goto :stop
if /I "%ACTION%"=="restart" goto :restart
if /I "%ACTION%"=="status"  goto :status

echo Usage: %~nx0 {start^|stop^|restart^|status}
popd >nul
exit /b 1

:start
call :is_running RUNPID
if defined RUNPID (
  echo PM Panel already running ^(pid !RUNPID!^) on http://localhost:%PM_PANEL_PORT%
  popd >nul
  exit /b 0
)
echo Starting PM Panel on port %PM_PANEL_PORT% ...
start "PM Panel" /B cmd /c "node index.js > "%LOG_FILE%" 2>&1"
REM Capture pid of the node child (best effort)
timeout /t 2 /nobreak >nul
for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>nul') do (
  set "NPID=%%~P"
  echo !NPID! > "%PID_FILE%"
)
call :is_running RUNPID
if defined RUNPID (
  echo Started ^(pid !RUNPID!^). Logs: %LOG_FILE%
) else (
  echo Failed to start. See %LOG_FILE%
  popd >nul
  exit /b 1
)
popd >nul
exit /b 0

:stop
call :is_running RUNPID
if not defined RUNPID (
  echo PM Panel is not running.
  if exist "%PID_FILE%" del /q "%PID_FILE%"
  popd >nul
  exit /b 0
)
echo Stopping PM Panel ^(pid !RUNPID!^) ...
taskkill /PID !RUNPID! /T /F >nul 2>nul
REM Sweep any stragglers running index.js from this folder
for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>nul') do (
  taskkill /PID %%~P /F >nul 2>nul
)
if exist "%PID_FILE%" del /q "%PID_FILE%"
echo Stopped.
popd >nul
exit /b 0

:restart
call :stop
call :start
exit /b %errorlevel%

:status
call :is_running RUNPID
if defined RUNPID (
  echo PM Panel running ^(pid !RUNPID!^) on http://localhost:%PM_PANEL_PORT%
) else (
  echo PM Panel is not running.
)
popd >nul
exit /b 0

:is_running
set "%~1="
if exist "%PID_FILE%" (
  set /p _PID=<"%PID_FILE%"
  if defined _PID (
    tasklist /FI "PID eq !_PID!" 2>nul | find "!_PID!" >nul
    if not errorlevel 1 (
      set "%~1=!_PID!"
      exit /b 0
    )
  )
)
REM Fallback: any node.exe (best-effort on Windows)
for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>nul') do (
  set "%~1=%%~P"
  exit /b 0
)
exit /b 0
