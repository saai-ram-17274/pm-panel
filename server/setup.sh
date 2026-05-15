#!/usr/bin/env bash
# PM Panel one-time setup script (Linux/macOS)
# Installs prerequisites: Node deps, rebuilds native modules, optional Playwright Chromium.
# Usage: ./setup.sh [--with-playwright]

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WITH_PLAYWRIGHT=0
for arg in "$@"; do
  case "$arg" in
    --with-playwright) WITH_PLAYWRIGHT=1 ;;
    -h|--help)
      echo "Usage: $0 [--with-playwright]"
      echo "  --with-playwright   Also install Playwright Chromium (for Zoho browser-download path)"
      exit 0 ;;
  esac
done

echo "==> PM Panel setup"
echo "    Folder: $SCRIPT_DIR"

# 1) Node check
if [[ -x "$HOME/.nvm/versions/node/v20.20.2/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin/node"
  NPM_BIN="$HOME/.nvm/versions/node/v20.20.2/bin/npm"
  export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
else
  echo "ERROR: Node.js is not installed."
  echo "       Install Node.js 20.x:"
  echo "         - via nvm:    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 20"
  echo "         - via apt:    sudo apt install -y nodejs npm"
  echo "         - via brew:   brew install node@20"
  exit 1
fi

NODE_VER="$($NODE_BIN -v)"
echo "==> Node:  $NODE_BIN ($NODE_VER)"
echo "==> npm:   $NPM_BIN"

MAJOR="${NODE_VER#v}"; MAJOR="${MAJOR%%.*}"
if (( MAJOR < 18 )); then
  echo "ERROR: Node.js >= 18 required (found $NODE_VER)."
  exit 1
fi

# 2) Build toolchain check (needed for better-sqlite3 native build if no prebuilt)
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "WARN: build tools (make/g++/python3) not all present."
  echo "      better-sqlite3 usually ships prebuilt binaries, but if install fails:"
  echo "        Debian/Ubuntu: sudo apt install -y build-essential python3"
  echo "        Fedora:        sudo dnf install -y @development-tools python3"
  echo "        macOS:         xcode-select --install"
fi

# 3) npm install
echo "==> Installing npm dependencies (this may take a minute)..."
"$NPM_BIN" install --no-audit --no-fund
echo "==> Dependencies installed."

# 4) Verify better-sqlite3 loads
echo "==> Verifying better-sqlite3 native binding..."
if "$NODE_BIN" -e "require('better-sqlite3'); console.log('ok')" >/dev/null 2>&1; then
  echo "    OK"
else
  echo "    FAIL — rebuilding native module..."
  "$NPM_BIN" rebuild better-sqlite3 || { echo "ERROR: better-sqlite3 rebuild failed."; exit 1; }
fi

# 5) Optional: Playwright chromium
if (( WITH_PLAYWRIGHT == 1 )); then
  if [[ -d node_modules/playwright ]] || [[ -d node_modules/playwright-core ]]; then
    echo "==> Installing Playwright Chromium..."
    "$NPM_BIN" exec --yes -- playwright install chromium || echo "WARN: playwright install failed; Zoho browser-download path may not work."
  else
    echo "==> Skipping Playwright (package not in dependencies)."
  fi
fi

# 6) Inbox folder
INBOX="$HOME/pm-panel/spoc-inbox"
mkdir -p "$INBOX"
echo "==> SPOC inbox: $INBOX"

# 7) Make control script executable
chmod +x "$SCRIPT_DIR/pm-panel.sh" 2>/dev/null || true

echo ""
echo "==> Setup complete."
echo "    Start the server:  ./pm-panel.sh start"
echo "    Then open:         http://localhost:${PM_PANEL_PORT:-4000}"
