#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

say() { printf '%s\n' "$*"; }

if ! command -v omp >/dev/null 2>&1; then
  say "ERROR: omp is not in PATH"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  say "ERROR: python3 is required"
  exit 1
fi

say "OMP compaction order: shake -> handoff"
if [[ $DRY_RUN -eq 0 ]]; then
  omp config set compaction.methodOrder '["shake","handoff"]' --json >/dev/null
else
  say "DRY-RUN: omp config set compaction.methodOrder '[\"shake\",\"handoff\"]' --json"
fi

mapfile -t HELPERS < <(
  {
    find "${HOME}/.codex-chatgpt-web/versions" -mindepth 3 -maxdepth 3 -type f -path '*/app/browser-helper.cjs' 2>/dev/null || true
    if [[ -f "${HOME}/.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs" ]]; then
      printf '%s\n' "${HOME}/.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs"
    fi
  } | awk '!seen[$0]++'
)

if [[ ${#HELPERS[@]} -eq 0 ]]; then
  say "No known browser-helper.cjs install found; OMP config was still handled."
  exit 0
fi

for helper in "${HELPERS[@]}"; do
  say "Checking: ${helper}"
  if [[ $DRY_RUN -eq 1 ]]; then
    python3 - "$helper" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text(errors="strict")
selector = "already-30s" if "selectorTimeoutMs??30000" in s else ("patchable-5s" if "selectorTimeoutMs??5000" in s else "unknown")
send = "already-120s" if "send:120000" in s else ("patchable-60s" if "send:60000" in s else ("patchable-20s" if "send:20000" in s else "unknown"))
print(f"  selector timeout: {selector}")
print(f"  send timeout:     {send}")
PY
    continue
  fi

  ts="$(date +%Y%m%d-%H%M%S)"
  backup="${helper}.pre-stability-fix-${ts}.bak"
  cp -a -- "$helper" "$backup"

  python3 - "$helper" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(errors="strict")
changed = []

if "selectorTimeoutMs??30000" not in s:
    old = "selectorTimeoutMs??5000"
    if old in s:
        if s.count(old) != 1:
            raise SystemExit(f"refusing selector patch: expected 1 match, got {s.count(old)}")
        s = s.replace(old, "selectorTimeoutMs??30000")
        changed.append("selector timeout 5s -> 30s")
    else:
        print("  selector timeout: unknown layout; left unchanged")
else:
    print("  selector timeout: already 30s")

if "send:120000" not in s:
    candidates = [marker for marker in ["send:20000", "send:60000"] if marker in s]
    if len(candidates) > 1:
        raise SystemExit("refusing send patch: multiple budget markers")
    old = candidates[0] if candidates else None
    if old:
        if s.count(old) != 1:
            raise SystemExit(f"refusing send patch: expected 1 match, got {s.count(old)}")
        s = s.replace(old, "send:120000")
        changed.append("send timeout " + ("20s" if old == "send:20000" else "60s") + " -> 120s")
    else:
        print("  send timeout: unknown layout; left unchanged")
else:
    print("  send timeout: already 120s")

if changed:
    p.write_text(s)
    print("  changed: " + ", ".join(changed))
else:
    print("  no browser-helper change needed")
PY
  say "  backup: ${backup}"
done

say "Done. Run ./bin/check.sh to verify."
