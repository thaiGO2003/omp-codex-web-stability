#!/usr/bin/env python3
"""Recover browser failures before output or at a completed tool boundary."""
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
# Upgrade both fresh installs and the previous recovery helper. Inspect error
# objects only: assistant text and quoted conversation history are not errors.
source = changes[path]
start = source.index('function chatGptFetchRecoveryEligible(')
end = source.index('function x_(', start)
if end < start or source[start:end].count('function ') != 1:
    raise SystemExit('Unknown recovery helper layout; no files changed')
platform_helper = '''function chatGptPlatformToolBlocked(error){
for(let depth=0;error&&typeof error==="object"&&depth<4;depth++,error=error.cause){
if(error.code==="chatgpt_platform_tool_blocked"||error.code==="content_filter")return true;
if(typeof error.message==="string"&&/blocked by OpenAI|couldn['’]t determine the safety status of the request/i.test(error.message))return true;
}
return false;
}'''.replace('\n', '')
if 'function chatGptPlatformToolBlocked(' not in source:
    source = source[:start] + platform_helper + source[start:]
marker = 'function chatGptFetchRecoveryEligible(session,error,originalError,roundKey,incoming,parsed){'
guard = 'if(chatGptPlatformToolBlocked(error)||chatGptPlatformToolBlocked(originalError))return false;'
if marker + guard not in source:
    source = source.replace(marker, marker + guard)
marker = 'let oe=x_(O,re);'
classification = ('if(chatGptPlatformToolBlocked(oe)||chatGptPlatformToolBlocked(re))'
                  '{oe.code="chatgpt_platform_tool_blocked";oe.retryable=false;'
                  'oe.errorType="permission_error";oe.status=403;}')
if marker + classification not in source:
    if source.count(marker) != 1:
        raise SystemExit('Unknown platform rejection handler; no files changed')
    source = source.replace(marker, marker + classification)
changes[path] = source
# A browser execution spans several native HTTP rounds. Completed results from
# the preceding round must be available before replacing a broken execution.
source = changes[path]
start = source.index('function chatGptFetchRecoveryEligible(')
end = source.index('function x_(', start)
decision_start = source.find('function chatGptFetchRecoveryDecision(')
if decision_start >= 0:
    if decision_start > start:
        raise SystemExit('Unknown continuation recovery layout; no files changed')
    start = decision_start
decision = '''function chatGptFetchRecoveryDecision(session,error,originalError,roundKey,incoming,parsed){
let no=reason=>({eligible:false,reason});
if(chatGptPlatformToolBlocked(error)||chatGptPlatformToolBlocked(originalError))return no("platform_rejection");
if(incoming.abortSignal?.aborted)return no("cancelled");
if(parsed._compactionRequest)return no("compaction");
if(session.runtime.manualControl)return no("manual_control");
let missing=error?.code==="chatgpt_submitted_turn_failed"&&originalError?.message==="ChatGPT accepted the message but did not expose its assistant turn in the DOM"&&session.runtime.submission?.phase==="accepted";
if(error?.code!=="chatgpt_fetch_failed"&&error?.code!=="upstream_server_error"&&!missing)return no("other_error");
if(session.roundEvents(roundKey).some(event=>["text_delta","thinking_delta","tool_call","tool_call_start","tool_call_delta","tool_call_end"].includes(event.type)))return no("round_output");
let pending=session.outstanding(),progress=session.runtime.mode==="tools"?session.runtime.externalProgress?.snapshot():undefined;
if(session.runtime.mode==="tools"&&!progress)return no("missing_progress");
let known=new Set([...(session.deliveredResultIds??[]),...pending.map(call=>call.callId)]),boundary=false;
if(known.size>0&&progress&&progress.lastToolBatchRevision>0){
if([...known].some(id=>typeof id!=="string"||!id))return no("unknown_tool_id");
let results=new Map;
for(let message of parsed.context?.messages??[])if(message.role==="toolResult"&&known.has(message.toolCallId))results.set(message.toolCallId,(results.get(message.toolCallId)??0)+1);
if([...known].some(id=>results.get(id)!==1))return no("incomplete_tool_results");
if(progress.activeToolCalls!==0&&progress.activeToolCalls!==pending.length)return no("active_tools");
boundary=true;
}
if(pending.length&&!boundary)return no("pending_tools");
if(session.runtime.text.value().length&&!boundary)return no("uncommitted_text");
if(progress&&(progress.lastToolBatchRevision!==0||progress.activeToolCalls!==0)&&!boundary)return no("tool_progress");
return{eligible:true,reason:boundary?"completed_tool_boundary":"before_output"};
}function chatGptFetchRecoveryEligible(session,error,originalError,roundKey,incoming,parsed){
return chatGptFetchRecoveryDecision(session,error,originalError,roundKey,incoming,parsed).eligible;
}'''.replace('\n', '')
source = source[:start] + decision + source[end:]
start = source.index('if(fetchRecoveryAttempts<2&&chatGptFetchRecoveryEligible(')
previous_decision = 'let fetchDecision=chatGptFetchRecoveryDecision(O,oe,re,U,y,f);'
if source[:start].endswith(previous_decision):
    start -= len(previous_decision)
end = source.index('let C=oe instanceof q&&oe.retryable?', start)
branch = '''let fetchDecision=chatGptFetchRecoveryDecision(O,oe,re,U,y,f);
if(fetchRecoveryAttempts<2&&chatGptFetchRecoveryEligible(O,oe,re,U,y,f)){
let batchRevision=O.runtime.externalProgress?.snapshot().lastToolBatchRevision;
await O.runtime.retireCapability?.();
let afterRevoke=O.runtime.externalProgress?.snapshot().lastToolBatchRevision;
if(chatGptFetchRecoveryEligible(O,oe,re,U,y,f)&&afterRevoke===batchRevision){
await De.retireAndWait(be,y.abortSignal);
if(y.abortSignal?.aborted)throw new DOMException("ChatGPT web turn aborted","AbortError");
if(chatGptFetchRecoveryEligible(O,oe,re,U,y,f)&&O.runtime.externalProgress?.snapshot().lastToolBatchRevision===batchRevision){
fetchRecoveryAttempts++;fetchRecoveryRequested=true;Hn.clear(D);
console.warn(`[chatgpt-web] fetch-recovery ${fetchRecoveryAttempts}/2: revoked old capability and retired browser execution (${oe.code}, ${fetchDecision.reason})`);
return;
}
fetchDecision={eligible:false,reason:"retirement_race"};
}else fetchDecision={eligible:false,reason:"revocation_race"};
}
if(oe?.code==="chatgpt_fetch_failed"||(oe?.code==="upstream_server_error"&&fetchDecision.eligible)){
let reason=fetchRecoveryAttempts>=2&&fetchDecision.eligible?"attempt_budget_exhausted":fetchDecision.reason;
console.warn(`[chatgpt-web] fetch-recovery stopped: ${JSON.stringify({reason,attempts:fetchRecoveryAttempts,code:oe.code})}`);
oe.code="chatgpt_recovery_stopped";oe.message=`ChatGPT browser recovery stopped (${reason}). Tool outcomes already received by OMP remain in its session. See local recovery diagnostics.`;
oe.status=409;oe.errorType="invalid_request_error";oe.retryable=false;
De.retire(be,O);
}
if(oe?.code==="upstream_server_error"&&["accepted","send_activated"].includes(O.runtime.submission?.phase))oe.retryable=false;
'''.replace('\n', '')
source = source[:start] + branch + source[end:]
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
