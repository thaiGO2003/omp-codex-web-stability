#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"
settings="$here/settings.json"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$settings" ]] || die "settings.json not found: $settings"
command -v python3 >/dev/null 2>&1 || die "python3 is required to read settings.json"

read_setting() {
  python3 - "$settings" "$1" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1]))[sys.argv[2]]
except Exception as error:
    print(f'ERROR: cannot read {sys.argv[2]} from settings.json: {error}', file=sys.stderr)
    raise SystemExit(1)
print(value)
PY
}

port="$(read_setting shimPort)"
upstream="$(read_setting upstreamUrl)"
bun="$(read_setting bunPath)"

[[ "$port" =~ ^[0-9]+$ ]] || die "Invalid shim port in settings.json: $port"
(( port >= 1 && port <= 65535 )) || die "Invalid shim port in settings.json: $port"
origin="http://127.0.0.1:$port"

health="$(curl -fsS --max-time 2 "$origin/omp-shim-health" 2>/dev/null || true)"

compatible_health() {
  python3 - "$1" "$upstream" <<'PY'
import json, sys
try:
    health = json.loads(sys.argv[1] or '{}')
except Exception:
    raise SystemExit(1)
if health.get('service') != 'omp-codex-web-shim':
    raise SystemExit(1)
if health.get('upstreamOrigin') != sys.argv[2]:
    raise SystemExit(1)
PY
}

port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

exec 9>"$here/.shim-launcher.lock"
if ! flock -n 9; then
  compatible_health "$health" || die "Another shim launcher owns port $port but the health endpoint is not compatible. Check it before retrying."
  echo "OMP shim already running at $origin; reusing the existing process."
  exit 0
fi

if [[ -n "$health" ]]; then
  compatible_health "$health" || die "Port $port belongs to another shim/service or upstream. Choose a different shim port."
  echo "OMP shim already running at $origin; no second process started."
  exit 0
fi

if port_busy; then
  die "Port $port is occupied by a process that does not respond as the OMP shim. Close that process or use a different shim port."
fi

[[ -x "$bun" ]] || die "Bun not found at the configured path: $bun"
[[ -f "$here/server.ts" ]] || die "server.ts not found in $here"

echo "OMP shim -> $upstream. Keep this process running while using OMP."
exec env OMP_CODEX_WEB_SHIM_PORT="$port" OMP_CODEX_WEB_UPSTREAM="$upstream" "$bun" "$here/server.ts"
