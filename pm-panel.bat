@echo off
REM PM Panel server control script (Windows)
REM Usage: pm-panel.bat {start|stop|restart|status}
REM
REM The Node server writes its own PID to .pm-panel.pid on listen() and removes
REM it on graceful exit. We only ever act on that PID — never scan for stray
REM node.exe processes (which would clash with unrelated node apps like VS Code
REM language servers).

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

if "%PM_PANEL_PORT%"=="" set "PM_PANEL_PORT=4000"
set "LOG_FILE=%SCRIPT_DIR%pm-panel.log"
set "PID_FILE=%SCRIPT_DIR%pm-panel.pid"

REM Resolve node binary
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node not found in PATH.
  popd >nul
  exit /b 1
)

set "ACTION=%~1"
if /I "%ACTION%"=="start"   goto :do_start
if /I "%ACTION%"=="stop"    goto :do_stop
if /I "%ACTION%"=="restart" goto :do_restart
if /I "%ACTION%"=="status"  goto :do_status

echo Usage: %~nx0 {start^|stop^|restart^|status}
popd >nul
exit /b 1

:do_start
call :is_running RUNPID
if defined RUNPID (
  echo PM Panel already running ^(pid !RUNPID!^) on http://localhost:%PM_PANEL_PORT%
  popd >nul
  exit /b 0
)
REM Clear any stale PID file from a crashed previous run.
if exist "%PID_FILE%" del /q "%PID_FILE%"

echo Starting PM Panel on port %PM_PANEL_PORT% ...

REM Detach a background cmd that runs node with output redirected to the log.
REM /B = no new window. The `>` truncates the log atomically as node opens it.
start "PM Panel" /B cmd /c "node index.js > "%LOG_FILE%" 2>&1"

REM Wait up to ~10 seconds for node to bind the port and write its PID file.
set /a _TRIES=0
:wait_pid
if exist "%PID_FILE%" goto :pid_ready
set /a _TRIES+=1
if !_TRIES! geq 20 (
  echo Failed to start ^(timed out waiting for PID file^). See %LOG_FILE%
  popd >nul
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto :wait_pid

:pid_ready
call :is_running RUNPID
if defined RUNPID (
  echo Started ^(pid !RUNPID!^) on http://localhost:%PM_PANEL_PORT%. Logs: %LOG_FILE%
  popd >nul
  exit /b 0
) else (
  echo Failed to start. See %LOG_FILE%
  popd >nul
  exit /b 1
)

:do_stop
call :is_running RUNPID
if not defined RUNPID (
  echo PM Panel is not running.
  if exist "%PID_FILE%" del /q "%PID_FILE%"
  popd >nul
  exit /b 0
)
echo Stopping PM Panel ^(pid !RUNPID!^) ...
taskkill /PID !RUNPID! /T /F >nul 2>nul
REM Wait briefly so the OS releases file handles and the listening port.
timeout /t 2 /nobreak >nul
if exist "%PID_FILE%" del /q "%PID_FILE%"
echo Stopped.
popd >nul
exit /b 0

:do_restart
call :do_stop
call :do_start
exit /b %errorlevel%

:do_status
call :is_running RUNPID
if defined RUNPID (
  echo PM Panel running ^(pid !RUNPID!^) on http://localhost:%PM_PANEL_PORT%
) else (
  echo PM Panel is not running.
)
popd >nul
exit /b 0

REM ---------------------------------------------------------------------------
REM :is_running OUTVAR
REM   Sets OUTVAR to the live PM Panel PID, or leaves it empty.
REM   Only trusts %PID_FILE% — never scans for arbitrary node processes.
REM ---------------------------------------------------------------------------
:is_running
set "%~1="
if not exist "%PID_FILE%" exit /b 0
set "_PID="
set /p _PID=<"%PID_FILE%"
if not defined _PID exit /b 0
REM Strip whitespace / CR
for /f "tokens=* delims= " %%A in ("!_PID!") do set "_PID=%%A"
set "_PID=!_PID: =!"
if "!_PID!"=="" exit /b 0
tasklist /FI "PID eq !_PID!" /FI "IMAGENAME eq node.exe" 2>nul | find "!_PID!" >nul
if errorlevel 1 exit /b 0
set "%~1=!_PID!"
exit /b 0
