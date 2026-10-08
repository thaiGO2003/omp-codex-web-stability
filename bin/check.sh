#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '--- OMP ---'
if command -v omp >/dev/null 2>&1; then
  printf 'compaction.methodOrder = '
  omp config get compaction.methodOrder || true
else
  echo 'omp: not found'
fi

printf '\n%s\n' '--- Codex Web helpers ---'
mapfile -t HELPERS < <(
  {
    find "${HOME}/.codex-chatgpt-web/versions" -mindepth 3 -maxdepth 3 -type f -path '*/app/browser-helper.cjs' 2>/dev/null || true
    [[ -f "${HOME}/.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs" ]] && printf '%s\n' "${HOME}/.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs"
  } | awk '!seen[$0]++'
)

if [[ ${#HELPERS[@]} -eq 0 ]]; then
  echo 'no known browser-helper.cjs found'
  exit 0
fi

for helper in "${HELPERS[@]}"; do
  python3 - "$helper" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text(errors="replace")
selector = "30s" if "selectorTimeoutMs??30000" in s else ("5s" if "selectorTimeoutMs??5000" in s else "unknown")
send = "120s" if "send:120000" in s else ("60s" if "send:60000" in s else ("20s" if "send:20000" in s else "unknown"))
print(p)
print(f"  selector timeout: {selector}")
print(f"  send timeout:     {send}")
PY
done
