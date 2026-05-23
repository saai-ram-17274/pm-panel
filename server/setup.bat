@echo off
REM PM Panel one-time setup script (Windows)
REM Installs prerequisites: Node deps, rebuilds native modules, Playwright headless Chromium.
REM Usage: setup.bat [--skip-playwright]

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

REM Playwright headless-shell is required for the SPOC remote-download path.
REM Default ON; pass --skip-playwright to skip the ~120MB download.
set "WITH_PLAYWRIGHT=1"
if /I "%~1"=="--skip-playwright" set "WITH_PLAYWRIGHT=0"
if /I "%~1"=="--no-playwright"   set "WITH_PLAYWRIGHT=0"
if /I "%~1"=="--with-playwright" set "WITH_PLAYWRIGHT=1"
if /I "%~1"=="-h"     goto :usage
if /I "%~1"=="--help" goto :usage

echo ==^> PM Panel setup
echo     Folder: %SCRIPT_DIR%

REM 1) Node check
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo        Install Node.js 20.x LTS from: https://nodejs.org/en/download/
  echo        Or via winget:  winget install OpenJS.NodeJS.LTS
  popd >nul
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found in PATH.
  popd >nul
  exit /b 1
)

for /f "delims=" %%V in ('node -v') do set "NODE_VER=%%V"
echo ==^> Node:  !NODE_VER!

REM Major version check (>= 18)
set "NV=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%A in ("!NV!") do set "NMAJOR=%%A"
if !NMAJOR! LSS 18 (
  echo ERROR: Node.js ^>= 18 required ^(found !NODE_VER!^).
  popd >nul
  exit /b 1
)

REM 2) Build toolchain hint (for native modules)
where python >nul 2>nul
if errorlevel 1 (
  echo WARN: Python not found. better-sqlite3 usually ships prebuilt binaries.
  echo       If npm install fails, install: winget install Python.Python.3.12
  echo       And:                            npm install --global windows-build-tools
)

REM 3) npm install
echo ==^> Installing npm dependencies ^(this may take a minute^)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo ERROR: npm install failed.
  popd >nul
  exit /b 1
)
echo ==^> Dependencies installed.

REM 4) Verify better-sqlite3 loads
echo ==^> Verifying better-sqlite3 native binding...
node -e "require('better-sqlite3'); console.log('ok')" >nul 2>nul
if errorlevel 1 (
  echo     FAIL -- rebuilding native module...
  call npm rebuild better-sqlite3
  if errorlevel 1 (
    echo ERROR: better-sqlite3 rebuild failed.
    popd >nul
    exit /b 1
  )
) else (
  echo     OK
)

REM 5) Playwright headless Chromium (needed by the SPOC remote-download path).
REM    The runtime only ever calls chromium.launch({ headless: true }), which
REM    since Playwright 1.49+ uses chromium-headless-shell. Installing the
REM    headless-shell build (~120MB) instead of full chromium (~300MB).
if "%WITH_PLAYWRIGHT%"=="1" (
  if exist node_modules\playwright (
    echo ==^> Installing Playwright headless Chromium...
    call npx --yes playwright install chromium-headless-shell
  ) else if exist node_modules\playwright-core (
    echo ==^> Installing Playwright headless Chromium...
    call npx --yes playwright install chromium-headless-shell
  ) else (
    echo ==^> Skipping Playwright ^(package not in dependencies^).
  )
) else (
  echo ==^> Skipping Playwright per --skip-playwright. SPOC remote download will fail until you run:
  echo     npx playwright install chromium-headless-shell
)

REM 6) Inbox folder
set "INBOX=%USERPROFILE%\pm-panel\spoc-inbox"
if not exist "%INBOX%" mkdir "%INBOX%"
echo ==^> SPOC inbox: %INBOX%

echo.
echo ==^> Setup complete.
echo     Start the server:  pm-panel.bat start
if "%PM_PANEL_PORT%"=="" (
  echo     Then open:         http://localhost:4000
) else (
  echo     Then open:         http://localhost:%PM_PANEL_PORT%
)
popd >nul
exit /b 0

:usage
echo Usage: %~nx0 [--skip-playwright]
echo   ^(Playwright headless Chromium is installed by default for the SPOC remote-download path^)
echo   --skip-playwright   Do not download the ~120MB headless-shell
popd >nul
exit /b 0
