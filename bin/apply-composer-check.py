#!/usr/bin/env python3
"""Stop blind OMP overload retries for the known missing-composer UI failure."""
import argparse
from datetime import datetime
import hashlib
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
KNOWN = {
    'tool-call-ids.ts': '74d94d4f6c81196f3f9979883d3c638654b9a0e6bbc576aa85c75fc5fe881a52',
}


def install(directory, dry_run=False):
    changes = {}
    for name, known in KNOWN.items():
        path = directory / name
        current = path.read_bytes()
        desired = (ROOT / 'shim' / name).read_bytes()
        if current == desired:
            continue
        if hashlib.sha256(current).hexdigest() != known:
            raise ValueError(f'{name}: unknown layout; no files changed')
        changes[path] = desired
    if dry_run:
        print('Would update:', ', '.join(p.name for p in changes) or 'already installed')
        return
    snapshots = {p: p.read_bytes() for p in changes}
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    try:
        for path, data in changes.items():
            shutil.copy2(path, path.with_name(path.name + '.pre-composer-check-' + stamp + '.bak'))
            temporary = path.with_name(path.name + '.composer-check.tmp')
            temporary.write_bytes(data)
            temporary.replace(path)
    except BaseException:
        for path, data in snapshots.items():
            path.with_name(path.name + '.composer-check.tmp').unlink(missing_ok=True)
            path.write_bytes(data)
        raise
    print('Composer check installed; restart only the idle shim.' if changes else 'Already installed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shim-dir', type=Path, default=Path.home() / '.local/share/codex-chatgpt-web-omp-shim')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    install(args.shim_dir, args.dry_run)
