#!/usr/bin/env python3
"""Upgrade a known OMP shim to fresh native ownership on silent recovery."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
PATCHES = json.loads((ROOT / 'fixes/recovery-identity.json').read_text())['replacements']
UPGRADES = json.loads((ROOT / 'fixes/recovery-identity.json').read_text()).get('upgrades', [])


def patched_server(source):
    for upgrade in UPGRADES:
        if upgrade['old'] in source:
            if source.count(upgrade['old']) != 1:
                raise ValueError('Ambiguous earlier identity patch; no files changed')
            source = source.replace(upgrade['old'], upgrade['new'], 1)
    installed = [source.count(p['new']) == 1 for p in PATCHES]
    if all(installed):
        return source
    if any(installed):
        raise ValueError('Partial recovery identity patch; no files changed')
    for patch in PATCHES:
        if source.count(patch['old']) != 1:
            raise ValueError('Unknown shim recovery layout; no files changed')
    for patch in PATCHES:
        source = source.replace(patch['old'], patch['new'], 1)
    return source


def install(directory, dry_run=False):
    server = directory / 'server.ts'
    updated = patched_server(server.read_text())
    module = directory / 'sse-watchdog.ts'
    changes = {server: updated, module: (ROOT / 'fixes/sse-watchdog.ts').read_text()}
    changes = {p: s for p, s in changes.items() if not p.exists() or p.read_text() != s}
    if dry_run:
        print('Would update:', ', '.join(str(p) for p in changes) or 'already installed')
        return
    snapshots = {p: p.read_bytes() if p.exists() else None for p in changes}
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    try:
        for p, text in changes.items():
            if p.exists():
                shutil.copy2(p, p.with_name(p.name + '.pre-recovery-identity-' + stamp + '.bak'))
            p.write_text(text)
    except BaseException:
        for p, data in snapshots.items():
            if data is None:
                p.unlink(missing_ok=True)
            else:
                p.write_bytes(data)
        raise
    print('Recovery identity installed; restart the shim only when idle.' if changes else 'Already installed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shim-dir', type=Path, default=Path.home() / '.local/share/codex-chatgpt-web-omp-shim')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    install(args.shim_dir, args.dry_run)
