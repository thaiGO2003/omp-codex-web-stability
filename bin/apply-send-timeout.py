#!/usr/bin/env python3
"""Restore the ordinary Send budget in known Codex Web helper layouts."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import tempfile


def patch_text(text):
    known = ['send:20000,', 'send:60000,', 'send:120000,']
    present = [marker for marker in known if marker in text]
    if len(present) != 1 or text.count(present[0]) != 1:
        raise ValueError('Unknown or ambiguous ordinary Send timeout; no changes made')
    if present[0] == known[-1]:
        return text, False
    return text.replace(present[0], known[-1], 1), True


def helpers(home):
    paths = list((home / '.codex-chatgpt-web/versions').glob('*/app/browser-helper.cjs'))
    descriptor = home / '.codex-chatgpt-web/runtime/launcher-browser.json'
    if descriptor.is_file():
        script = json.loads(descriptor.read_text()).get('helper', {}).get('script')
        if script:
            paths.append(Path(script))
    paths.append(home / '.local/share/codex-web-ui-fix/AppDir/resources/runtime/app/browser-helper.cjs')
    # AppImage-mounted launcher resources are read-only. The installed runtime helper is writable.
    return sorted({p.resolve() for p in paths if p.is_file() and os.access(p, os.W_OK)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, action='append')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    paths = args.helper or helpers(Path.home())
    if not paths:
        parser.error('No writable browser helper found; use --helper PATH')
    pending = [(path, *patch_text(path.read_text())) for path in paths]
    for path, updated, changed in pending:
        if not changed:
            print('Already 120s:', path)
            continue
        if args.dry_run:
            print('Would set Send to 120s:', path)
            continue
        suffix = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        backup = path.with_name(path.name + '.pre-send-budget-' + suffix + '.bak')
        shutil.copy2(path, backup)
        fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(updated)
            shutil.copymode(path, temporary)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print('Send budget set to 120s:', path)
        print('Backup:', backup)
    print('Reload Codex Web while idle to load the patched helper.')


if __name__ == '__main__':
    main()
