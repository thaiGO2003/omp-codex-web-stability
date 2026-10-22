#!/usr/bin/env python3
"""Apply OMP Web setup changes with backups and rollback.

The change list comes from fixes/omp-web-config.ts (config.yml + models.yml) and
from the shim sources in this repository, mirroring the Windows installer.
"""
import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

SHIM_FILES = (
    'compatibility.ts',
    'diagnostics.ts',
    'omp-extension.ts',
    'server.ts',
    'sse-watchdog.ts',
    'start-shim.sh',
    'submitted-turn-retry.ts',
    'task-label.ts',
    'tool-call-ids.ts',
)


def settings_text(bun_path, upstream_url, shim_port):
    return json.dumps(
        {'bunPath': bun_path, 'upstreamUrl': upstream_url, 'shimPort': shim_port},
        indent=2,
    ) + '\n'


def collect(repo, shim_dir, agent_dir, bun_path, upstream_url, shim_port, prepared):
    changes = []
    for entry in prepared.get('changes', []):
        path = Path(entry['path'])
        changes.append((path, str(entry['text'])))
    for name in SHIM_FILES:
        source = repo / 'shim' / name
        if not source.is_file():
            raise ValueError(f'Missing shim source: {source}')
        changes.append((shim_dir / name, source.read_text()))
    changes.append((
        agent_dir / 'extensions/codex-chatgpt-web-compat.ts',
        (repo / 'shim/omp-extension.ts').read_text(),
    ))
    changes.append((
        shim_dir / 'settings.json',
        settings_text(bun_path, upstream_url, shim_port),
    ))

    unique = {}
    for path, text in changes:
        unique[path] = text
    return [
        (path, text)
        for path, text in unique.items()
        if not path.is_file() or path.read_text() != text
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--shim-dir', type=Path, required=True)
    parser.add_argument('--agent-dir', type=Path, required=True)
    parser.add_argument('--changes', type=Path, required=True)
    parser.add_argument('--bun', required=True)
    parser.add_argument('--upstream-url', required=True)
    parser.add_argument('--shim-port', type=int, required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    try:
        prepared = json.loads(args.changes.read_text() or '{}')
        changes = collect(
            args.repo.resolve(), args.shim_dir, args.agent_dir,
            args.bun, args.upstream_url, args.shim_port, prepared,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1

    if not changes:
        print('OMP Web configuration and shim files are already current.')
        return 0

    if args.dry_run:
        for path, _ in changes:
            print(f'Would write: {path}')
        return 0

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    snapshots = {}
    for path, _ in changes:
        snapshots[path] = path.read_bytes() if path.is_file() else None

    try:
        for path, text in changes:
            if path.is_file():
                backup = path.with_name(path.name + '.pre-web-setup-' + stamp + '.bak')
                shutil.copy2(path, backup)
                print(f'Backup: {backup}')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            if path.name == 'start-shim.sh':
                path.chmod(0o755)
    except Exception:
        for path, content in snapshots.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(content)
        raise

    for path, _ in changes:
        print(f'Wrote: {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
