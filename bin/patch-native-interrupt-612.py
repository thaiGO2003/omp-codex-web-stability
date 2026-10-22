#!/usr/bin/env python3
"""Patch Codex Web 6.1.12's scoped cancellation ACK to await physical retirement.

The stock endpoint returns success before physical cleanup finishes. Repeated
interrupts must also join the original settlement; a zero-count ACK from a
second request is not evidence that the first request has settled.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


HEALTH_FROM = 'version:Ct,mode:e.mode,pid:process.pid'
HEALTH_TO = 'version:Ct,scoped_interrupt_settled:!0,mode:e.mode,pid:process.pid'
MAP_FROM = '},m=Bun.serve({hostname:e.host,port:e.port,idleTimeout:0,async fetch(w){'
MAP_TO = '},__ompScopedInterruptSettlements=new Map,m=Bun.serve({hostname:e.host,port:e.port,idleTimeout:0,async fetch(w){'
INTERRUPT_FROM = (
    'let b=new DOMException("Codex turn interrupted","AbortError"),'
    'T=He.cancelNativeTurn(f.threadId,f.turnId,b),G=Hf(f.threadId,f.turnId,b),'
    'N=u.beginCancelTurn(f,b);'
    'return Promise.allSettled([T.settlement,G.settlement,N.settlement]).then((C)=>'
    '{for(let _ of C)if(_.status==="rejected")console.error('
    '`[chatgpt-web] interrupted turn cleanup failed: ${_.reason instanceof Error?_.reason.message:String(_.reason)}`)}),'
    'Response.json({status:"ok",cancelled_http_turns:N.cancelled,'
    'cancelled_browser_turns:T.cancelled,cancelled_compaction_runs:G.cancelled})'
)
INTERRUPT_TO = (
    'let __ompKey=f.threadId+"\\x00"+f.turnId,'
    '__ompPending=__ompScopedInterruptSettlements.get(__ompKey);'
    'if(__ompPending)return await __ompPending;'
    'let b=new DOMException("Codex turn interrupted","AbortError"),'
    'T=He.cancelNativeTurn(f.threadId,f.turnId,b),G=Hf(f.threadId,f.turnId,b),'
    'N=u.beginCancelTurn(f,b);'
    '__ompPending=Promise.allSettled([T.settlement,G.settlement,N.settlement]).then((C)=>{'
    'if(C.some(_=>_.status==="rejected")){'
    'for(let _ of C)if(_.status==="rejected")console.error('
    '`[chatgpt-web] interrupted turn cleanup failed: ${_.reason instanceof Error?_.reason.message:String(_.reason)}`);'
    'return Response.json({status:"error",code:"interrupt_cleanup_failed"},{status:503})}'
    'return Response.json({status:"ok",cancelled_http_turns:N.cancelled,'
    'cancelled_browser_turns:T.cancelled,cancelled_compaction_runs:G.cancelled})});'
    '__ompScopedInterruptSettlements.set(__ompKey,__ompPending);'
    'try{return await __ompPending}finally{'
    'if(__ompScopedInterruptSettlements.get(__ompKey)===__ompPending)'
    '__ompScopedInterruptSettlements.delete(__ompKey)}'
)


def patch_content(source: str) -> str:
    if HEALTH_TO in source and INTERRUPT_TO in source and MAP_TO in source:
        return source
    for before, after in ((HEALTH_FROM, HEALTH_TO), (MAP_FROM, MAP_TO), (INTERRUPT_FROM, INTERRUPT_TO)):
        if source.count(before) != 1:
            raise ValueError(f"Unsupported vendor bundle: patch anchor occurs {source.count(before)} times")
        source = source.replace(before, after, 1)
    return source


def sync_manifest(cli: Path, apply: bool) -> None:
    """Keep the runtime file-integrity manifest in sync with the patched CLI.

    Require the manifest's old hash to match the byte-for-byte vendor backup.
    An unexpected manifest must never be silently rewritten.
    """
    manifest = cli.parent.parent / 'manifest.json'
    current = manifest.read_bytes()
    payload = json.loads(current)
    if payload.get('appVersion') != '6.1.12' or payload.get('entrypoint') != 'app/cli.js':
        raise ValueError('Unexpected 6.1.12 runtime manifest')
    entries = [entry for entry in payload.get('files', []) if entry.get('path') == 'app/cli.js']
    if len(entries) != 1:
        raise ValueError('Manifest has no unique cli.js entry')
    entry = entries[0]
    source = cli.read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if entry['sha256'] == digest and entry['size'] == len(source):
        return
    vendor_backup = cli.with_name(cli.name + '.pre-omp-settled-interrupt.bak')
    vendor = vendor_backup.read_bytes()
    if (entry['sha256'] != hashlib.sha256(vendor).hexdigest()
            or entry['size'] != len(vendor)):
        raise ValueError('Unexpected manifest contents; refusing to change checksum')
    if not apply:
        print('Manifest checksum needs updating (--apply to write)')
        return
    manifest_backup = manifest.with_name(manifest.name + '.pre-omp-settled-interrupt.bak')
    if manifest_backup.exists():
        if manifest_backup.read_bytes() != current:
            raise ValueError('Existing manifest backup differs from current original')
    else:
        shutil.copy2(manifest, manifest_backup)
    entry['sha256'] = digest
    entry['size'] = len(source)
    updated = (json.dumps(payload, indent=2, ensure_ascii=False) + '\n').encode()
    with tempfile.NamedTemporaryFile(dir=manifest.parent, delete=False) as tmp:
        tmp.write(updated)
        tmp_path = Path(tmp.name)
    try:
        os.chmod(tmp_path, manifest.stat().st_mode)
        os.replace(tmp_path, manifest)
    finally:
        tmp_path.unlink(missing_ok=True)
    print(f'Manifest checksum updated; original saved as {manifest_backup.name}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cli', type=Path, help='Codex Web 6.1.12 app/cli.js')
    parser.add_argument('--apply', action='store_true', help='Create a backup and patch the bundle')
    args = parser.parse_args()
    original = args.cli.read_text()
    patched = patch_content(original)
    if patched == original:
        print('Already patched with settled, idempotent scoped interruption')
        sync_manifest(args.cli, apply=args.apply)
        return
    with tempfile.TemporaryDirectory() as directory:
        fixture = Path(directory) / 'cli.js'
        fixture.write_text(patched)
        subprocess.run(['node', '--check', str(fixture)], check=True, stdout=subprocess.DEVNULL)
    if not args.apply:
        print('Vendor 6.1.12 layout verified; patch available (--apply to write)')
        return
    backup = args.cli.with_name(args.cli.name + '.pre-omp-settled-interrupt.bak')
    if backup.exists():
        if backup.read_text() != original:
            raise ValueError(f'Existing backup differs from installed bundle: {backup}')
    else:
        shutil.copy2(args.cli, backup)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.cli.parent, delete=False) as tmp:
        tmp.write(patched)
        tmp_path = Path(tmp.name)
    try:
        os.chmod(tmp_path, args.cli.stat().st_mode)
        os.replace(tmp_path, args.cli)
    finally:
        tmp_path.unlink(missing_ok=True)
    print(f'Patched scoped interruption; original saved as {backup.name}')
    sync_manifest(args.cli, apply=True)


if __name__ == '__main__':
    main()
