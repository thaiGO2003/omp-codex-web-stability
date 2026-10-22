#!/usr/bin/env bash
set -uo pipefail

here="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"
cd "$here" || exit 1

log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/omp-codex-web-stability"
mkdir -p "$log_dir" || exit 1
log_file="$log_dir/install-and-run-$(date +%Y%m%d-%H%M%S).log"
ln -sfn "$log_file" "$log_dir/latest.log"
exec > >(tee -a "$log_file") 2>&1

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
fi

pause() {
  [[ -t 0 ]] || return 0
  printf '\nPress Enter to close...'
  read -r _ || true
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  printf 'Log: %s\n' "$log_file"
  pause
  exit 1
}

echo "OMP + Codex Web Stability - install and run"
echo "Repo: $here"
echo "Log:  $log_file"
echo

command -v omp >/dev/null 2>&1 || fail "omp not found in PATH. Install it with: bun install -g @oh-my-pi/pi-coding-agent"
command -v python3 >/dev/null 2>&1 || fail "python3 not found."

if (( dry_run )); then
  echo "== [1/3] Preview OMP Web setup (config + shim) =="
  ./bin/setup-omp-codex-web.sh --dry-run || fail "bin/setup-omp-codex-web.sh --dry-run failed."
  echo
  echo "== [2/3] Preview stability fixes =="
  ./bin/apply.sh --dry-run || fail "bin/apply.sh --dry-run failed."
  echo
  echo "Dry run finished. Nothing was changed."
  echo "Log: $log_file"
  pause
  exit 0
fi

echo "== [1/3] OMP Web setup (model roles, provider, shim) =="
./bin/setup-omp-codex-web.sh || fail "bin/setup-omp-codex-web.sh failed (see output above)."
echo
echo "== [2/3] Applying stability fixes =="
./bin/apply.sh || fail "bin/apply.sh failed (see output above)."
echo
echo "== [3/3] Verifying =="
./bin/check.sh || fail "bin/check.sh failed (see output above)."
echo
echo "Finished successfully."
echo "Log: $log_file"
pause
