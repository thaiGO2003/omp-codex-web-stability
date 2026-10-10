#!/usr/bin/env python3
"""Retry failed pre-output browser turns inside the same OMP/API request."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('runtime', type=Path)
parser.add_argument('--dry-run', action='store_true')
options = parser.parse_args()
root = options.runtime.resolve()
manifest_path = root / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
if manifest.get('appVersion') != '6.1.7' or manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64':
    raise SystemExit('Supported runtime: Codex Web 6.1.7 linux-x64; no files changed')
for name in ('cli.js', 'browser-helper.cjs'):
    path = root / 'app' / name
    record = next(r for r in manifest['files'] if r['path'] == 'app/' + name)
    content = path.read_bytes()
    if len(content) != record['size'] or hashlib.sha256(content).hexdigest() != record['sha256']:
        raise SystemExit(f'{name}: existing manifest mismatch; no files changed')
    if 'ChatGPT conversation request failed in the browser' not in content.decode():
        raise SystemExit('Apply patch-fetch-failure.py first; no files changed')
changes = {}
path = root / 'app/cli.js'
source = path.read_text()
if 'function chatGptFetchRecoveryEligible(' not in source:
    helper = '''function chatGptFetchRecoveryEligible(session,error,originalError,roundKey,incoming,parsed){
if(incoming.abortSignal?.aborted||parsed._compactionRequest||session.runtime.manualControl)return false;
let missing=error?.code==="chatgpt_submitted_turn_failed"&&originalError?.message==="ChatGPT accepted the message but did not expose its assistant turn in the DOM"&&session.runtime.submission?.phase==="accepted";
if(error?.code!=="chatgpt_fetch_failed"&&error?.code!=="upstream_server_error"&&!missing)return false;
if(session.runtime.text.value().length||session.outstanding().length)return false;
if(session.roundEvents(roundKey).some(event=>event.type==="text_delta"||event.type==="thinking_delta"||event.type==="tool_call"))return false;
if(session.runtime.mode==="tools"){
let progress=session.runtime.externalProgress?.snapshot();
if(!progress||progress.lastToolBatchRevision!==0||progress.activeToolCalls!==0)return false;
}
return true;
}'''.replace('\n', '')
    marker = 'function x_(e,t)'
    if source.count(marker) != 1:
        raise SystemExit('Unknown submitted failure classifier')
    source = source.replace(marker, helper + marker)
    marker = ';let B=async()=>{let _=Et(f.modelId);'
    if source.count(marker) != 1:
        raise SystemExit('Unknown adapter execution entry')
    source = source.replace(marker, ';let fetchRecoveryAttempts=0,fetchRecoveryRequested=false;let B=async()=>{let _=Et(f.modelId);')
    marker = 'let oe=x_(O,re),C=oe instanceof q&&oe.retryable?'
    if source.count(marker) != 1:
        raise SystemExit('Unknown adapter failure handler')
    branch = '''let oe=x_(O,re);
if(fetchRecoveryAttempts<2&&chatGptFetchRecoveryEligible(O,oe,re,U,y,f)){
await O.runtime.retireCapability?.();
if(chatGptFetchRecoveryEligible(O,oe,re,U,y,f)){
await De.retireAndWait(be,y.abortSignal);
if(y.abortSignal?.aborted)throw new DOMException("ChatGPT web turn aborted","AbortError");
fetchRecoveryAttempts++;fetchRecoveryRequested=true;Hn.clear(D);
console.warn(`[chatgpt-web] fetch-recovery ${fetchRecoveryAttempts}/2: revoked old capability and retired browser execution (${oe.code})`);
return;
}}
if(fetchRecoveryAttempts>=2&&chatGptFetchRecoveryEligible(O,oe,re,U,y,f)){
oe.message+=" ChatGPT recovery failed after 2 automatic retries.";oe.retryable=false;
}
if(oe?.code==="upstream_server_error"&&["accepted","send_activated"].includes(O.runtime.submission?.phase))oe.retryable=false;
let C=oe instanceof q&&oe.retryable?'''.replace('\n', '')
    source = source.replace(marker, branch)
    marker = 'try{P({type:"heartbeat"}),await B()}finally{clearInterval(T)}'
    if source.count(marker) != 1:
        raise SystemExit('Unknown adapter heartbeat lifecycle')
    loop = '''try{P({type:"heartbeat"});
for(;;){fetchRecoveryRequested=false;await B();if(!fetchRecoveryRequested)break;
await eo(new Promise(resolve=>setTimeout(resolve,fetchRecoveryAttempts===1?2000:5000)),y.abortSignal);
}}finally{clearInterval(T)}'''.replace('\n', '')
    source = source.replace(marker, loop)
else:
    print('Adapter recovery already patched')
    marker = 'let C=oe instanceof q&&oe.retryable?'
    exhausted = ('if(fetchRecoveryAttempts>=2&&chatGptFetchRecoveryEligible(O,oe,re,U,y,f))'
                 '{oe.message+=" ChatGPT recovery failed after 2 automatic retries.";oe.retryable=false;}'
                 'if(oe?.code==="upstream_server_error"&&["accepted","send_activated"].includes(O.runtime.submission?.phase))oe.retryable=false;')
    if 'ChatGPT recovery failed after 2 automatic retries.' not in source:
        if source.count(marker) != 1:
            raise SystemExit('Unknown recovery exhaustion handler')
        source = source.replace(marker, exhausted + marker)
changes[path] = source
for name in ('cli.js', 'browser-helper.cjs'):
    path = root / 'app' / name
    source = changes.get(path, path.read_text())
    source = source.replace('The prompt may already have reached ChatGPT; automatic resubmission is disabled.',
                            'The prompt may already have reached ChatGPT.')
    source = source.replace('Automatic prompt resubmission is disabled.',
                            'The browser request failed before an assistant response appeared.')
    changes[path] = source
changes = {p: s for p, s in changes.items() if p.read_text() != s}
if not changes:
    raise SystemExit(0)
for path, source in changes.items():
    record = next(r for r in manifest['files'] if r['path'] == path.relative_to(root).as_posix())
    record['size'] = len(source.encode())
    record['sha256'] = hashlib.sha256(source.encode()).hexdigest()
digest = hashlib.sha256()
for record in manifest['files']:
    for value in (record['path'], str(record['size']), record['sha256']):
        digest.update(value.encode() + b'\0')
manifest['bundleId'] = digest.hexdigest()
if options.dry_run:
    print('Would patch', len(changes), 'bundles; new bundleId', manifest['bundleId'])
else:
    backup = root.parent / 'codex-web-stability-backups' / ('fetch-retry-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    for path, source in changes.items():
        shutil.copy2(path, backup / path.name)
        path.write_text(source)
    shutil.copy2(manifest_path, backup / 'manifest.json')
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print('Patched', len(changes), 'bundles; backup', backup, 'bundleId', manifest['bundleId'])
