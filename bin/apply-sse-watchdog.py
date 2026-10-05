#!/usr/bin/env python3
"""Install the tested SSE guard into an existing OMP compatibility shim."""
import argparse
from datetime import datetime
from pathlib import Path
import json
import shutil
import sys

# Both native Windows PowerShell and Python use the same guarded patch definition.
MANIFEST = json.loads((Path(__file__).resolve().parent.parent / 'fixes/sse-integration.json').read_text())
WATCHDOG_IMPORT = MANIFEST['installedMarkers'][0]
OLD_BODY = MANIFEST['replacements'][-1]['old']
NEW_BODY = MANIFEST['replacements'][-1]['new']
INTERRUPT_FUNCTION = MANIFEST['installedMarkers'][2] + '\n'


def replace_once(text, old, new):
    count = text.count(old)
    if count != 1:
        raise ValueError(f"Unsupported shim layout: expected one {old!r}, got {count}; no files changed")
    return text.replace(old, new, 1)


def patched_server(text):
    # Refuse partial installs/custom integration rather than guessing boundaries.
    if WATCHDOG_IMPORT in text:
        for marker in MANIFEST['installedMarkers']:
            if marker not in text:
                raise ValueError("Existing watchdog integration differs from the tested layout; no files changed")
        return text
    for replacement in MANIFEST['replacements']:
        text = replace_once(text, replacement['old'], replacement['new'])
    return text


def install(shim_dir, dry_run=False):
    server = shim_dir / 'server.ts'
    if not server.is_file():
        raise ValueError(f"Existing compatibility shim required: {server}")
    module_source = Path(__file__).resolve().parent.parent / 'fixes/sse-watchdog.ts'
    original = server.read_text()
    updated = patched_server(original)  # Validate everything before writes/backups.
    module = shim_dir / 'sse-watchdog.ts'
    files = []
    if updated != original:
        files.append((server, updated))
    module_text = module_source.read_text()
    if not module.exists() or module.read_text() != module_text:
        files.append((module, module_text))
    if not files:
        print('SSE watchdog already installed (240 seconds without semantic progress).')
        return
    if dry_run:
        for path, _ in files:
            print(f'Would install: {path}')
        return
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    snapshots = {path: path.read_bytes() if path.exists() else None for path, _ in files}
    try:
        for path, text in files:
            if path.exists():
                backup = path.with_name(path.name + '.pre-sse-watchdog-' + stamp + '.bak')
                shutil.copy2(path, backup)
                print(f'Backup: {backup}')
            path.write_text(text)
    except Exception:
        for path, content in snapshots.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(content)
        raise
    print('Installed. Restart the compatibility shim when its active turns have finished:')
    print('  systemctl --user restart codex-chatgpt-web-omp-shim.service')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shim-dir', type=Path, default=Path.home() / '.local/share/codex-chatgpt-web-omp-shim')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        install(args.shim_dir, args.dry_run)
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
