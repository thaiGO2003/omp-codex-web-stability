#!/usr/bin/env python3
"""Guarded Codex Web 6.1.4 connector/turn rebinding patch."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def patch_text(text, manifest):
    patches = manifest['patches']
    if all(text.count(p['new']) == 1 for p in patches):
        return text, False
    previous = manifest.get('previousPatches', [])
    if previous and all(text.count(p['new']) == 1 for p in previous):
        # Upgrade the exact previously released layout in memory, before any write.
        for patch in previous:
            text = text.replace(patch['new'], patch['old'], 1)
    for patch in patches:
        if text.count(patch['old']) != 1 or patch['new'] in text:
            raise ValueError('Unknown or partially patched helper layout: ' + patch['name'])
    for patch in patches:
        text = text.replace(patch['old'], patch['new'], 1)
    return text, True

def helpers(home):
    paths = list((home / '.codex-chatgpt-web/versions').glob('*/app/browser-helper.cjs'))
    descriptor = home / '.codex-chatgpt-web/runtime/launcher-browser.json'
    if descriptor.exists():
        path = json.loads(descriptor.read_text()).get('helper', {}).get('script')
        if path:
            paths.append(Path(path))
    paths.append(home / '.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs')
    return sorted({p.resolve() for p in paths if p.is_file()})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, action='append')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'fixes/browser-rebinding.json').read_text())
    paths = args.helper or helpers(Path.home())
    if not paths:
        parser.error('No installed browser-helper.cjs found; supply --helper PATH')
    # Validate every target before changing any file.
    pending = [(p, *patch_text(p.read_text(), manifest)) for p in paths]
    for path, text, changed in pending:
        if not changed:
            print('Already patched:', path)
            continue
        if args.dry_run:
            print('Would patch:', path)
            continue
        suffix = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        backup = path.with_name(path.name + '.pre-connector-rebinding-' + suffix + '.bak')
        shutil.copy2(path, backup)
        fd, temporary = tempfile.mkstemp(prefix=path.name+'.', suffix='.tmp', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(text)
            shutil.copymode(path, temporary)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print('Patched:', path)
        print('Backup:', backup)
    print('Close and reopen Codex Web when no turn is running to load the new helper.')

if __name__ == '__main__':
    main()
