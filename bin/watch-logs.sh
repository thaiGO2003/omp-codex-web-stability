#!/usr/bin/env bash
set -uo pipefail

here="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"
repo="$(cd -- "$here/.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/omp-codex-web-stability"
latest="$state/latest.log"
shim_log="$HOME/.local/share/codex-chatgpt-web-omp-shim/shim.log"
unit="codex-chatgpt-web-omp-shim"

mkdir -p "$state"
if [[ ! -e "$latest" ]]; then
  : > "$state/install-and-run-latest.log"
  ln -sfn "$state/install-and-run-latest.log" "$latest"
  printf '%s\n' "No launcher run yet. Start it from the desktop shortcut or run ./install-and-run.sh." >> "$state/install-and-run-latest.log"
fi

launcher_cmd="tail -n 200 -F '$latest'"
if command -v journalctl >/dev/null 2>&1 && journalctl --user -u "$unit" -n 1 >/dev/null 2>&1; then
  shim_cmd="journalctl --user -u $unit -f -n 60 --no-pager"
else
  shim_cmd="tail -n 60 -F '$shim_log'"
fi

if command -v tmux >/dev/null 2>&1; then
  session="omp-logs"
  if tmux has-session -t "$session" 2>/dev/null; then
    exec tmux attach -t "$session"
  fi
  tmux new-session -d -s "$session" -c "$repo" "$launcher_cmd"
  tmux split-window -v -t "$session" -c "$repo" "$shim_cmd"
  first_pane="$(tmux list-panes -t "$session:" -F '#{pane_id}' | head -1)"
  tmux select-pane -t "$first_pane"
  exec tmux attach -t "$session"
fi

echo "Live logs (Ctrl+C to stop)."
echo "  launcher: $latest"
echo "  shim:     $shim_cmd"
echo
tail -n 200 -F "$latest" | sed -u 's/^/[launcher] /' &
launcher_tail=$!
tail -n 60 -F "$shim_log" 2>/dev/null | sed -u 's/^/[shim] /' &
shim_tail=$!
trap 'kill "$launcher_tail" "$shim_tail" 2>/dev/null' EXIT
wait
