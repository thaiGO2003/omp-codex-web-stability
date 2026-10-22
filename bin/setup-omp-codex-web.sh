#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Configures OMP Web model roles and installs the full compatibility shim (Linux).

Usage: bin/setup-omp-codex-web.sh [options]

  --agent-dir DIR        OMP agent directory (default: $PI_CODING_AGENT_DIR or ~/.omp/agent)
  --shim-dir DIR         Shim install directory (default: ~/.local/share/codex-chatgpt-web-omp-shim)
  --upstream-url URL     Local Codex Web origin (default: http://127.0.0.1:17841)
  --shim-port PORT       Shim listen port (default: 3007)
  --judge-base-url URL   Optional legacy 9router base URL
  --bun-path PATH        Bun executable (default: bun from PATH)
  --no-start             Install without starting the shim service
  --no-systemd           Do not create the systemd --user unit
  --dry-run              Show the files that would change
  -h, --help             Show this help
EOF
}

say() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

agent_dir=""
shim_dir=""
upstream_url="http://127.0.0.1:17841"
shim_port="3007"
judge_base_url=""
bun_path=""
start_shim=1
use_systemd=1
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-dir) agent_dir="${2:-}"; shift 2 ;;
    --shim-dir) shim_dir="${2:-}"; shift 2 ;;
    --upstream-url) upstream_url="${2:-}"; shift 2 ;;
    --shim-port) shim_port="${2:-}"; shift 2 ;;
    --judge-base-url) judge_base_url="${2:-}"; shift 2 ;;
    --bun-path) bun_path="${2:-}"; shift 2 ;;
    --no-start) start_shim=0; shift ;;
    --no-systemd) use_systemd=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage >&2; exit 2 ;;
  esac
done

repo="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)"

if [[ -z "$bun_path" ]]; then
  bun_path="$(command -v bun || true)"
fi
[[ -n "$bun_path" ]] || { err "Bun not found. Install Bun or pass --bun-path."; exit 1; }
[[ -x "$bun_path" ]] || { err "Bun is not executable: $bun_path"; exit 1; }
command -v python3 >/dev/null 2>&1 || { err "python3 is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl is required."; exit 1; }
[[ "$shim_port" =~ ^[0-9]+$ ]] || { err "Shim port must be numeric."; exit 1; }

[[ -n "$agent_dir" ]] || agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
[[ -n "$shim_dir" ]] || shim_dir="$HOME/.local/share/codex-chatgpt-web-omp-shim"

upstream_origin="$(python3 - "$upstream_url" "$shim_port" "$judge_base_url" <<'PY'
import sys
from urllib.parse import urlsplit

raw, shim_port, judge = sys.argv[1], int(sys.argv[2]), sys.argv[3]
url = urlsplit(raw)
if url.scheme not in ('http', 'https'):
    raise SystemExit('UpstreamUrl must be an http(s) origin, for example http://127.0.0.1:17841.')
if not url.hostname or url.hostname not in ('127.0.0.1', 'localhost', '::1', '[::1]'):
    raise SystemExit('UpstreamUrl must be the local Codex Web origin, for example http://127.0.0.1:17841.')
if url.username or url.password or url.query or url.fragment or url.path not in ('', '/', '/v1', '/v1/'):
    raise SystemExit('UpstreamUrl must be the local Codex Web HTTP origin without credentials, query or path.')
port = url.port or (443 if url.scheme == 'https' else 80)
if port == shim_port:
    raise SystemExit('Shim port must differ from the Codex Web upstream port.')
if judge:
    judge_url = urlsplit(judge)
    if judge_url.scheme not in ('http', 'https') or judge_url.username or judge_url.password:
        raise SystemExit('JudgeBaseUrl must be an HTTP URL without credentials.')
print(f'{url.scheme}://{url.hostname}:{port}')
PY
)" || { err "Invalid upstream URL."; exit 1; }

shim_origin="http://127.0.0.1:$shim_port"

config_path="$agent_dir/config.yml"
[[ -f "$config_path" || ! -f "$agent_dir/config.yaml" ]] || config_path="$agent_dir/config.yaml"
models_path="$agent_dir/models.yml"
[[ -f "$models_path" || ! -f "$agent_dir/models.yaml" ]] || models_path="$agent_dir/models.yaml"

prepare_file="$(mktemp)"
trap 'rm -f "$prepare_file"' EXIT

if ! "$bun_path" "$repo/fixes/omp-web-config.ts" \
      "$config_path" "$models_path" "$shim_origin/v1" ${judge_base_url:+"$judge_base_url"} \
      > "$prepare_file"; then
  err 'Invalid OMP config or models. No installation files changed.'
  exit 1
fi

existing_health="$(curl -fsS --max-time 1 "$shim_origin/omp-shim-health" 2>/dev/null || true)"
if [[ -n "$existing_health" ]]; then
  if ! python3 - "$existing_health" "$upstream_origin" <<'PY'
import json, sys
health = json.loads(sys.argv[1])
raise SystemExit(0 if health.get('service') == 'omp-codex-web-shim' and health.get('upstreamOrigin') == sys.argv[2] else 1)
PY
  then
    err "Shim port $shim_port is already used by a different shim. Choose another --shim-port."
    exit 1
  fi
fi

if [[ -z "$existing_health" ]] && (exec 3<>"/dev/tcp/127.0.0.1/$shim_port") 2>/dev/null; then
  err "Shim port $shim_port is already occupied by another process. Close it or choose another --shim-port."
  exit 1
fi

apply_args=(
  --repo "$repo"
  --shim-dir "$shim_dir"
  --agent-dir "$agent_dir"
  --changes "$prepare_file"
  --bun "$bun_path"
  --upstream-url "$upstream_origin"
  --shim-port "$shim_port"
)
if (( dry_run )); then
  apply_args+=(--dry-run)
fi

python3 "$repo/bin/apply-web-setup.py" "${apply_args[@]}" || exit 1

if (( dry_run )); then
  say "OMP -> $shim_origin/v1 -> $upstream_origin"
  exit 0
fi

say "OMP roles and provider configured: $models_path"
say 'default/vision/plan/task/web: GPT-6 Sol Web high; advisor: GPT-6 Sol Web high; commit: Instant auto.'
say 'tiny/smol: GPT-6 Sol auto; memory: GPT-5.6 Sol high; slow: GPT-6 Sol high; judge: GPT-6 Sol Instant auto.'
say 'Unrelated roles and compaction settings preserved. Restart OMP after setup.'

wait_for_health() {
  local deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 1 "$shim_origin/omp-shim-health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/codex-chatgpt-web-omp-shim.service"
systemd_available=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemd_available=1
fi

if (( use_systemd )) && (( systemd_available )); then
  unit_text="[Unit]
Description=OMP Codex Web compatibility shim
After=network.target

[Service]
Type=simple
WorkingDirectory=$shim_dir
Environment=OMP_CODEX_WEB_SHIM_PORT=$shim_port
Environment=OMP_CODEX_WEB_UPSTREAM=$upstream_origin
ExecStart=$bun_path $shim_dir/server.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
"
  mkdir -p "$unit_dir"
  if [[ ! -f "$unit_path" ]] || [[ "$(cat "$unit_path")" != "$unit_text" ]]; then
    if [[ -f "$unit_path" ]]; then
      backup="$unit_path.pre-web-setup-$(date +%Y%m%d-%H%M%S).bak"
      cp -p "$unit_path" "$backup"
      say "Backup: $backup"
    fi
    printf '%s' "$unit_text" > "$unit_path"
    say "Wrote: $unit_path"
  fi
  systemctl --user daemon-reload
  if (( start_shim )); then
    if [[ -n "$existing_health" ]]; then
      systemctl --user restart codex-chatgpt-web-omp-shim.service
    else
      systemctl --user enable --now codex-chatgpt-web-omp-shim.service
    fi
    if wait_for_health; then
      say "Shim ready: $shim_origin"
    else
      say 'WARNING: Shim did not report ready yet. Check: systemctl --user status codex-chatgpt-web-omp-shim.service'
    fi
  else
    say 'Start shim: systemctl --user enable --now codex-chatgpt-web-omp-shim.service'
  fi
elif (( use_systemd )); then
  say "WARNING: systemd --user is unavailable; no service was created. Start the shim with: $shim_dir/start-shim.sh"
else
  say "Start shim: $shim_dir/start-shim.sh"
fi

if (( start_shim )) && ! { (( use_systemd )) && (( systemd_available )); }; then
  mkdir -p "$shim_dir"
  nohup "$shim_dir/start-shim.sh" >> "$shim_dir/shim.log" 2>&1 &
  if wait_for_health; then
    say "Shim ready: $shim_origin (log: $shim_dir/shim.log)"
  else
    say "WARNING: Shim did not report ready yet. Check: $shim_dir/shim.log"
  fi
fi

if models_json="$(curl -fsS --max-time 3 "$upstream_origin/v1/models" 2>/dev/null)"; then
  if python3 - "$models_json" <<'PY'
import json, sys
try:
    ids = {model.get('id') for model in (json.loads(sys.argv[1]).get('data') or [])}
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if {'chatgpt-web/gpt-6-sol', 'chatgpt-web/gpt-6-sol-instant'} <= ids else 1)
PY
  then
    say 'Codex Web model API reachable; GPT-6 Sol and Instant are listed.'
  else
    say 'WARNING: Codex Web responded but GPT-6 Sol or Instant is not listed. Check Codex Web version, login and available models.'
  fi
else
  say "WARNING: Codex Web API is not reachable at $upstream_origin. Start Codex Web and log in before using OMP; this script does not install Codex Web."
fi

say 'Judge: GPT-6 Sol Instant (Web).'
if [[ -n "$judge_base_url" ]]; then
  say 'Legacy 9router provider configured; judge remains on GPT-6 Sol Instant.'
fi
