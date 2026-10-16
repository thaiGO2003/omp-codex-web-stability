#!/usr/bin/env python3
"""Preserve connector ownership across saved ChatGPT turns in 6.1.7 linux-x64."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def replacements(name):
    # Reuse the verified complete-payload comparator, not a token or suffix match.
    manifest = json.loads((ROOT / 'fixes/browser-rebinding.json').read_text())
    comparator = manifest['patches'][0]['new']
    if name == 'browser-helper.cjs':
        old_compare = 'm.evaluate((x,f)=>{let y=x.querySelectorAll("[data-user-message-bubble]"),_=y.length===1?y[0].querySelectorAll("[data-search-result-target]"):[],C=(L)=>L.replace(/\\r\\n?/g,`\n`);return _.length===1&&C(_[0].innerText)===C(f)},t.submittedText)'
        old_send = 'async sendAttachedPrompt(e,t,r,n,o,i,s,a){let l=(await this.activeComposer(e)).locator("xpath=ancestor::form[1]").locator(xr);'
        new_send = 'async sendAttachedPrompt(e,t,r,n,o,i,s,a){let composer=await this.activeComposer(e);t.submittedAppMentionHref=await Ce(U(composer.evaluate((element,appName)=>{const mentions=[...element.querySelectorAll(\'[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]\')].filter(node=>node.getAttribute("app-mention-display-name")===appName);return mentions.length===1?mentions[0].getAttribute("app-mention-path")??undefined:undefined},this.config.appName),n));let l=composer.locator("xpath=ancestor::form[1]").locator(xr);'
        match, binding, replacement, user = 'h', 'r', 'd', 'l'
    elif name == 'cli.js':
        old_compare = 'p.evaluate((h,m)=>{let g=h.querySelectorAll("[data-user-message-bubble]"),w=g.length===1?g[0].querySelectorAll("[data-search-result-target]"):[],b=(f)=>f.replace(/\\r\\n?/g,`\n`);return w.length===1&&b(w[0].innerText)===b(m)},t.submittedText)'
        comparator = comparator.replace('m.evaluate(', 'p.evaluate(', 1)
        old_send = 'async sendAttachedPrompt(e,t,n,r,o,i,a,s){let l=(await this.activeComposer(e)).locator("xpath=ancestor::form[1]").locator(Ns);'
        new_send = 'async sendAttachedPrompt(e,t,n,r,o,i,a,s){let composer=await this.activeComposer(e);t.submittedAppMentionHref=await _t(Be(composer.evaluate((element,appName)=>{const mentions=[...element.querySelectorAll(\'[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]\')].filter(node=>node.getAttribute("app-mention-display-name")===appName);return mentions.length===1?mentions[0].getAttribute("app-mention-path")??undefined:undefined},this.config.appName),r));let l=composer.locator("xpath=ancestor::form[1]").locator(Ns);'
        match, binding, replacement, user = 'd', 'n', 'u', 'l'
    else:
        raise ValueError('Unknown bundle')
    error = 'ChatGPT opened another user turn while the bound assistant response was detached'
    old_guard = f'if(!{match})throw Error("{error}")'
    new_guard = (f'if({match}==="pending")return {binding};if(!{match})throw Error("{error}"'
                 f'+` (replacement=${{Boolean({replacement})}}, acceptedUser=${{Boolean(t.acceptedUserIdentity)}},'
                 f' sameUser=${{{user}===t.acceptedUserIdentity}}, appBound=${{Boolean(t.submittedAppMentionHref)}},'
                 ' submittedChars=${t.submittedText?.length??0})`)')
    return [(old_compare, comparator), (old_guard, new_guard), (old_send, new_send)]


def patch_text(source, name, replacements_for=None):
    patches = (replacements_for or replacements)(name)
    if all(source.count(new) == 1 for _, new in patches):
        return source
    if any(source.count(old) != 1 or new in source for old, new in patches):
        raise ValueError(f'{name}: unknown or partially patched browser rebinding layout')
    for old, new in patches:
        source = source.replace(old, new, 1)
    return source


def main(version='6.1.7', replacements_for=None, patcher=None):
    parser = argparse.ArgumentParser(description=f'Preserve connector ownership in Codex Web {version} Linux x64.')
    parser.add_argument('runtime', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    root = args.runtime.resolve()
    manifest_path = root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('appVersion'), manifest.get('platform'), manifest.get('arch')) != (version, 'linux', 'x64'):
        raise ValueError(f'Supported runtime: Codex Web {version} linux-x64; no files changed')
    changes = {}
    for name in ('cli.js', 'browser-helper.cjs'):
        path = root / 'app' / name
        records = [r for r in manifest['files'] if r['path'] == 'app/' + name]
        if len(records) != 1:
            raise ValueError(f'{name}: expected one manifest record; no files changed')
        data = path.read_bytes()
        record = records[0]
        if len(data) != record['size'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError(f'{name}: existing manifest mismatch; no files changed')
        if patcher:
            patched = patcher(data.decode(), name)
        else:
            patched = patch_text(data.decode(), name, replacements_for)
        if patched != data.decode():
            changes[path] = patched
        record['size'] = len(patched.encode())
        record['sha256'] = hashlib.sha256(patched.encode()).hexdigest()
    if not changes:
        print(f'{version} browser rebinding already patched')
        return
    digest = hashlib.sha256()
    for record in manifest['files']:
        for value in (record['path'], str(record['size']), record['sha256']):
            digest.update(value.encode() + b'\0')
    manifest['bundleId'] = digest.hexdigest()
    if args.dry_run:
        print('Would patch', len(changes), 'bundles; new bundleId', manifest['bundleId'])
        return
    backup = root.parent / 'codex-web-stability-backups' / ('rebinding-' + version.replace('.', '') + '-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    for path in changes:
        shutil.copy2(path, backup / path.name)
    shutil.copy2(manifest_path, backup / 'manifest.json')
    try:
        for path, source in changes.items():
            path.write_text(source)
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    except BaseException:
        for path in changes:
            shutil.copy2(backup / path.name, path)
        shutil.copy2(backup / 'manifest.json', manifest_path)
        raise
    print('Patched', len(changes), 'bundles; backup', backup, 'bundleId', manifest['bundleId'])


if __name__ == '__main__':
    main()
