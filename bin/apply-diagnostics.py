#!/usr/bin/env python3
"""Add bounded, content-free logging to a known OMP shim. Never restarts services."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
PATCHES = json.loads((ROOT / 'fixes/diagnostics-integration.json').read_text())['replacements']


def patched_server(source):
    installed = [source.count(p['new']) == 1 for p in PATCHES]
    if all(installed):
        return source
    if any(installed):
        raise ValueError('Partial diagnostics patch; no files changed')
    chosen = []
    for patch in PATCHES:
        matches = [p for p in [patch, *patch.get('alternatives', [])] if source.count(p['old']) == 1]
        if len(matches) != 1:
            raise ValueError('Unknown or ambiguous shim diagnostics layout; no files changed')
        chosen.append(matches[0])
    for patch in chosen:
        if source.count(patch['old']) != 1:
            raise ValueError('Overlapping diagnostics patches; no files changed')
        source = source.replace(patch['old'], patch['new'], 1)
    return source


def install(directory, dry_run=False):
    server = directory / 'server.ts'
    updated = patched_server(server.read_text())
    # Dependencies first; the entry point is replaced last. Running Bun requests
    # retain already-loaded modules until the operator performs an idle restart.
    desired = {directory / 'diagnostics.ts': (ROOT / 'shim/diagnostics.ts').read_text(),
               directory / 'sse-watchdog.ts': (ROOT / 'fixes/sse-watchdog.ts').read_text(), server: updated}
    changes = {p: text for p, text in desired.items() if not p.exists() or p.read_text() != text}
    if dry_run:
        print('Would update:', ', '.join(p.name for p in changes) or 'already installed')
        return
    snapshots = {p: p.read_bytes() if p.exists() else None for p in changes}
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    try:
        for path, text in changes.items():
            if path.exists():
                shutil.copy2(path, path.with_name(path.name + '.pre-diagnostics-' + stamp + '.bak'))
            temporary = path.with_name(path.name + '.diagnostics.tmp')
            temporary.write_text(text)
            temporary.replace(path)
    except BaseException:
        for path, data in snapshots.items():
            path.with_name(path.name + '.diagnostics.tmp').unlink(missing_ok=True)
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        raise
    print('Diagnostics installed; activate by restarting the shim only when idle.' if changes else 'Already installed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shim-dir', type=Path, default=Path.home() / '.local/share/codex-chatgpt-web-omp-shim')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    install(args.shim_dir, args.dry_run)
