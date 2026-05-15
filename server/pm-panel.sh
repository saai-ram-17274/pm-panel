#!/usr/bin/env bash
# PM Panel server control script (Linux/macOS)
# Usage: ./pm-panel.sh {start|stop|restart|status|logs}

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="/tmp/pm-panel.log"
PID_FILE="$SCRIPT_DIR/.pm-panel.pid"
PORT="${PM_PANEL_PORT:-4000}"

# Resolve node binary (prefer nvm-installed, then PATH)
if [[ -x "$HOME/.nvm/versions/node/v20.20.2/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "ERROR: node not found in PATH or at ~/.nvm/versions/node/v20.20.2/bin/node" >&2
  exit 1
fi

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  # Fallback: detect by command line + cwd matches this folder
  local cand
  for cand in $(pgrep -f "index\.js" 2>/dev/null); do
    local cwd
    cwd="$(readlink -f "/proc/$cand/cwd" 2>/dev/null || true)"
    if [[ "$cwd" == "$SCRIPT_DIR" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

start() {
  local pid
  pid="$(is_running || true)"
  if [[ -n "${pid:-}" ]]; then
    echo "PM Panel already running (pid $pid) on http://localhost:$PORT"
    return 0
  fi
  echo "Starting PM Panel ($NODE_BIN index.js) on port $PORT ..."
  nohup "$NODE_BIN" index.js > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  disown || true
  sleep 1
  if pid="$(is_running)" && [[ -n "$pid" ]]; then
    echo "Started (pid $pid). Logs: $LOG_FILE"
    tail -n 1 "$LOG_FILE" 2>/dev/null || true
  else
    echo "Failed to start. See $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
}

stop() {
  local pid
  pid="$(is_running || true)"
  if [[ -z "${pid:-}" ]]; then
    echo "PM Panel is not running."
    rm -f "$PID_FILE"
    return 0
  fi
  echo "Stopping PM Panel (pid $pid) ..."
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing pid $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  # Sweep any stragglers belonging to this folder
  for cand in $(pgrep -f "index\.js" 2>/dev/null); do
    cwd="$(readlink -f "/proc/$cand/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$SCRIPT_DIR" ]] && kill -9 "$cand" 2>/dev/null || true
  done
  echo "Stopped."
}

status() {
  local pid
  pid="$(is_running || true)"
  if [[ -n "${pid:-}" ]]; then
    echo "PM Panel running (pid $pid) on http://localhost:$PORT"
  else
    echo "PM Panel is not running."
  fi
}

logs() {
  tail -n 100 -f "$LOG_FILE"
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
