#!/usr/bin/env python3
"""Recognize owned ChatGPT transport failures without resubmitting prompts."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
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
changes = {}
def preserve_upstream_generation(source, name):
    guard = 'if(e.abortSignal.reason?.code==="chatgpt_fetch_failed")throw e.abortSignal.reason;'
    if guard in source:
        return source
    pattern = r'if\(e\.abortSignal\?\.aborted\)\{(?=let \w+=\w+\(\w+\);if\(await \w+\.isVisible)'
    source, count = re.subn(pattern, 'if(e.abortSignal?.aborted){' + guard, source)
    if count != 1:
        raise SystemExit(f'{name}: unknown running-turn cancellation layout')
    return source

for name in ('cli.js', 'browser-helper.cjs'):
    path = root / 'app' / name
    source = path.read_text()
    record = next(r for r in manifest['files'] if r['path'] == 'app/' + name)
    if len(path.read_bytes()) != record['size'] or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
        raise SystemExit(f'{name}: existing manifest mismatch; no files changed')
    if 'ChatGPT conversation request failed in the browser' in source:
        updated = preserve_upstream_generation(source, name)
        if updated != source:
            changes[path] = updated
        else:
            print('Already patched:', name)
        continue
    start = source.index('onRequestFailed=(e)=>{this.requests.delete(e),this.streams.delete(e)};')
    end = start + len('onRequestFailed=(e)=>{this.requests.delete(e),this.streams.delete(e)};')
    klass = re.search(r'let \w+=new (\w+)\("ChatGPT rejected this message because', source[end:])
    if not klass:
        raise SystemExit(f'{name}: rejection observer error class missing')
    error_class = klass[1]
    replacement = (
        'onRequestFailed=(e)=>{let owned=this.requests.has(e)||this.streams.has(e);'
        'this.requests.delete(e);this.streams.delete(e);if(!owned||!this.page)return;'
        'let reason=e.failure()?.errorText??"";'
        'if(!reason||/ERR_ABORTED|ABORT_ERR|cancelled|canceled/i.test(reason))return;'
        # Avoid leaking URLs or arbitrary browser messages through this error.
        'let category=reason.match(/\b(?:net::)?ERR_[A-Z_]+\b/)?.[0]??"network_error";'
        f'let error=new {error_class}("ChatGPT conversation request failed in the browser ("+category+"). "'
        '+"The prompt may already have reached ChatGPT; automatic resubmission is disabled.",'
        '{status:502,errorType:"server_error",code:"chatgpt_fetch_failed",retryable:!1});'
        'this.checks.push(Promise.resolve(error));this.onRejected?.(error)};'
    )
    source = source[:start] + replacement + source[end:]
    # Keep recognition scoped to error alerts, rather than quoted assistant text.
    start = source.index('async submissionDomState(')
    end = source.index('async ', start + len('async submissionDomState('))
    method = source[start:end]
    old = 'snapshot:{userTurnCount:'
    visible = re.search(r'(\w+)=\(\w+\)=>\{let \w+=\w+,\w+=getComputedStyle\(', method)
    if method.count(old) != 1 or not visible:
        raise SystemExit(f'{name}: unknown submission DOM layout')
    new = 'snapshot:{fetchFailureVisible:[...document.querySelectorAll(\'[role="alert"]\')].some((node)=>' + visible[1] + '(node)&&/\\bFailed to fetch\\b/i.test(node.textContent??"")),userTurnCount:'
    source = source[:start] + method.replace(old, new) + source[end:]
    start = source.index('async captureSubmissionBaseline(')
    end = source.index('async waitForNewAssistantTurn(', start)
    method = source[start:end]
    state = re.search(r'(\w+)=await this\.submissionDomState\(e,(\w+)\)', method)
    if not state or method.count('initialTurnIdentities:[]') != 1:
        raise SystemExit(f'{name}: unknown submission baseline layout')
    method = method.replace('initialTurnIdentities:[]', f'initialFetchFailureVisible:{state[1]}.fetchFailureVisible,initialTurnIdentities:[]')
    source = source[:start] + method + source[end:]
    start = source.index('async waitForNewAssistantTurn(')
    end = source.index('async reconcileAssistantTurnBinding(', start)
    method = source[start:end]
    # Observe a fresh failure of the exact accepted user turn before the DOM grace expires.
    found = re.search(r'if\((\w+)\.visibleStopButtonCount>0\)', method)
    suppress = re.search(r'&&!([\w$]+)\((\w+),Date\.now\(\)\)', method)
    if not found or not suppress:
        raise SystemExit(f'{name}: unknown assistant DOM wait layout')
    state_name, live_function, progress = found[1], suppress[1], suppress[2]
    insertion = (
        f'if({state_name}.fetchFailureVisible&&!l.initialFetchFailureVisible&&'
        f'{state_name}.visibleStopButtonCount===0&&!{live_function}({progress},Date.now())&&'
        f'l.acceptedUserIdentity&&{state_name}.userIdentities.includes(l.acceptedUserIdentity))'
        f'throw new {error_class}("ChatGPT displayed Failed to fetch for the accepted message. "'
        '+"Automatic prompt resubmission is disabled.",'
        '{status:502,errorType:"server_error",code:"chatgpt_fetch_failed",retryable:!1});'
    )
    method = method[:found.start()] + insertion + method[found.start():]
    source = source[:start] + method + source[end:]
    changes[path] = preserve_upstream_generation(source, name)

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
    backup = root.parent / 'codex-web-stability-backups' / ('fetch-failure-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True)
    for path, source in changes.items():
        shutil.copy2(path, backup / path.name)
        path.write_text(source)
    shutil.copy2(manifest_path, backup / 'manifest.json')
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print('Patched', len(changes), 'bundles; backup', backup, 'bundleId', manifest['bundleId'])
