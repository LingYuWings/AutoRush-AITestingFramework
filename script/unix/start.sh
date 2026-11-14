#!/usr/bin/env bash
# Start and supervise the loopback backend and Web console on Unix platforms.
set -euo pipefail

# Print a launcher error and trigger the registered exit cleanup.
fail() {
    printf '[AutoRush] %s\n' "$*" >&2
    exit 1
}

install=false
check_only=false
for option in "$@"; do
    case "$option" in
        --install) install=true ;;
        --check-only) check_only=true ;;
        -h|--help)
            cat <<'EOF'
Usage: bash script/<linux|macos>/start.sh [--install] [--check-only]

Starts the local AutoRush backend and Web console.
  --install     Install Python, frontend and Chromium dependencies.
  --check-only  Check the environment without starting services.

Set AUTORUSH_PYTHON to select the Python interpreter.
Set AUTORUSH_BACKEND_PORT and AUTORUSH_FRONTEND_PORT to change the ports.
EOF
            exit 0 ;;
        *) fail "Unknown option $option. See --help." ;;
    esac
done

workspace=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$workspace"
python=${AUTORUSH_PYTHON:-"$workspace/.venv-dev/bin/python"}
if [[ ! -x "$python" && -z "${AUTORUSH_PYTHON:-}" && -x "$workspace/.venv/bin/python" ]]; then
    python="$workspace/.venv/bin/python"
fi
command -v "$python" >/dev/null || fail 'Python environment is missing. Run python3 -m venv .venv-dev.'
"$python" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail 'Python 3.11 or later is required.'
command -v node >/dev/null || fail 'Node.js is required.'
command -v curl >/dev/null || fail 'curl is required.'

export AUTORUSH_CONFIG_PATH=${AUTORUSH_CONFIG_PATH:-"$workspace/autorush.settings.json"}
export AUTORUSH_LAUNCH_MODE=unix
settings_lines=$("$python" "$workspace/backend/src/autorush/config/runtime.py" --lines) || fail 'Could not read AutoRush runtime settings.'
while IFS='=' read -r key value; do
    if [[ -n "$key" ]] && ! printenv "$key" >/dev/null; then export "$key=$value"; fi
done <<< "$settings_lines"

export AUTORUSH_BACKEND_PORT=${AUTORUSH_BACKEND_PORT:-8000}
export AUTORUSH_FRONTEND_PORT=${AUTORUSH_FRONTEND_PORT:-5173}
for port in "$AUTORUSH_BACKEND_PORT" "$AUTORUSH_FRONTEND_PORT"; do
    if [[ ! "$port" =~ ^[1-9][0-9]{3,4}$ ]] || (( port < 1024 || port > 65535 )); then
        fail "Invalid port: $port. Use a port from 1024 to 65535."
    fi
done
[[ "$AUTORUSH_BACKEND_PORT" != "$AUTORUSH_FRONTEND_PORT" ]] || fail 'Backend and frontend ports must differ.'

export AUTORUSH_DESKTOP_ENABLED=0
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-"$workspace/.playwright-browsers"}
if "$install"; then
    command -v npm >/dev/null || fail 'npm is required to install frontend dependencies.'
    "$python" -m pip install -e "$workspace/backend[dev,web]"
    "$python" -m playwright install chromium
    (cd "$workspace/frontend" && npm install)
fi

vite="$workspace/frontend/node_modules/vite/bin/vite.js"
[[ -f "$vite" ]] || fail 'Frontend dependencies are missing. Run again with --install.'
"$python" -c 'from autorush.config.settings import Settings; import uvicorn, playwright' ||
    fail 'Backend dependencies are missing. Run again with --install.'
printf '[AutoRush] Environment check passed.\n'
if "$check_only"; then
    exit 0
fi

backend_url="http://127.0.0.1:$AUTORUSH_BACKEND_PORT"
frontend_url="http://127.0.0.1:$AUTORUSH_FRONTEND_PORT"
log_dir=${AUTORUSH_LOG_DIR:-"$workspace/artifacts/dev-logs"}
export AUTORUSH_LOG_DIR="$log_dir"
mkdir -p "$log_dir"
backend_pid=
frontend_pid=

# Signal both owned services before waiting for either one to exit.
cleanup() {
    local pid
    for pid in "$frontend_pid" "$backend_pid"; do
        [[ -n "$pid" ]] || continue
        kill "$pid" 2>/dev/null || true
    done
    for pid in "$frontend_pid" "$backend_pid"; do
        [[ -n "$pid" ]] || continue
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Poll the service endpoint and fail early if its child process exits.
wait_for_url() {
    local url=$1 pid=$2 log=$3 attempt
    for ((attempt = 0; attempt < 60; attempt++)); do
        kill -0 "$pid" 2>/dev/null || fail "Process exited before $url became available. See $log."
        if curl --noproxy '*' --fail --silent --max-time 1 "$url" >/dev/null; then
            sleep 0.5
            kill -0 "$pid" 2>/dev/null || fail "Process exited during startup. See $log."
            return
        fi
        sleep 0.5
    done
    fail "Timed out waiting for $url. See $log."
}

"$python" -m uvicorn autorush.api.app:app --host 127.0.0.1 --port "$AUTORUSH_BACKEND_PORT" --ws websockets \
    >"$log_dir/backend.out.log" 2>"$log_dir/backend.err.log" &
backend_pid=$!
wait_for_url "$backend_url/health" "$backend_pid" "$log_dir/backend.err.log"

(
    cd "$workspace/frontend"
    exec node "$vite" --host 127.0.0.1 --port "$AUTORUSH_FRONTEND_PORT" --strictPort
) >"$log_dir/frontend.out.log" 2>"$log_dir/frontend.err.log" &
frontend_pid=$!
wait_for_url "$frontend_url/health" "$frontend_pid" "$log_dir/frontend.err.log"

printf 'AutoRush is running.\n  Console: %s\n  API docs: %s/docs\n  Logs: %s\n' "$frontend_url" "$backend_url" "$log_dir"
printf 'Press Ctrl+C to stop both services.\n'
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
    sleep 1
done
fail "A service stopped unexpectedly. See $log_dir."
