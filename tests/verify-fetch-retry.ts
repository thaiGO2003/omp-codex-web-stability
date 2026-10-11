import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = process.argv[2];
if (!root) throw Error('Pass runtime directory');
const source = readFileSync(`${root}/app/cli.js`, 'utf8');
new Bun.Transpiler({ loader: 'js' }).transformSync(source);
const helperStart = source.indexOf('function chatGptPlatformToolBlocked(');
const helperEnd = source.indexOf('function x_(', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart);
const eligible = new Function(`${source.slice(helperStart, helperEnd)};return chatGptFetchRecoveryEligible`)();
const branchStart = source.indexOf('if(chatGptPlatformToolBlocked(oe)||chatGptPlatformToolBlocked(re))');
const branchEnd = source.indexOf('let C=oe instanceof q&&oe.retryable?', branchStart);
assert(branchStart >= 0 && branchEnd > branchStart);
const branch = source.slice(branchStart, branchEnd);
const loopStart = source.indexOf('try{P({type:"heartbeat"});for(;;){fetchRecoveryRequested=false;await B();');
const loopEnd = source.indexOf('finally{clearInterval(T)}', loopStart) + 'finally{clearInterval(T)}'.length;
assert(loopStart >= 0 && loopEnd > loopStart);
const loop = source.slice(loopStart, loopEnd);

for (const scenario of ['recover-first', 'recover-second', 'persistent', 'persistent-upstream', 'upstream-after-tools', 'missing-assistant', 'upstream-error', 'tools-ran', 'tools-active', 'pending-tool', 'output', 'thinking', 'cancelled', 'abort-delay', 'abort-retirement', 'revoke-race', 'revoke-failure', 'manual', 'compaction', 'ambiguous', 'auth', 'context-limit', 'other-DOM-error', 'platform-upstream', 'platform-fetch', 'platform-cause', 'platform-code', 'platform-before-send', 'quoted-history', 'completed-boundary', 'failed-tool-boundary', 'delivered-boundary', 'missing-old-result', 'missing-current-result', 'duplicate-current-result', 'foreign-result', 'native-tool-start', 'native-tool-end', 'boundary-revoke-race', 'boundary-active-race', 'boundary-output', 'boundary-platform', 'boundary-cancelled', 'persistent-boundary']) {
  const operations: string[] = [], delays: number[] = [];
  let terminal = 0, successes = 0, cleared = 0;
  const controller = new AbortController();
  const boundary = ['completed-boundary', 'failed-tool-boundary', 'delivered-boundary', 'missing-old-result', 'missing-current-result', 'duplicate-current-result', 'foreign-result', 'boundary-revoke-race', 'boundary-active-race', 'boundary-output', 'boundary-platform', 'boundary-cancelled', 'persistent-boundary'].includes(scenario);
  const pending = boundary && scenario !== 'delivered-boundary' ? [{ callId: 'call_current', wireName: 'bash' }] : scenario === 'pending-tool' ? [{}] : [];
  const progress = { lastToolBatchRevision: boundary ? 7 : ['tools-ran', 'upstream-after-tools'].includes(scenario) ? 1 : 0, activeToolCalls: boundary ? pending.length : scenario === 'tools-active' ? 1 : 0 };
  if (['cancelled', 'boundary-cancelled'].includes(scenario)) controller.abort();
  const O = {
    runtime: {
      mode: 'tools', manualControl: scenario === 'manual', submission: { phase: scenario === 'platform-before-send' ? 'prepared' : scenario === 'ambiguous' ? 'send_activated' : 'accepted' },
      text: { value: () => boundary ? 'Historical commentary from preceding tool rounds' : scenario === 'output' ? 'Existing answer' : '' },
      externalProgress: { snapshot: () => ({ ...progress }) },
      retireCapability: async () => {
        operations.push('revoke');
        if (scenario === 'revoke-race') progress.lastToolBatchRevision = 1;
        if (scenario === 'boundary-revoke-race') progress.lastToolBatchRevision++;
        if (scenario === 'boundary-active-race') progress.activeToolCalls++;
        if (scenario === 'revoke-failure') throw Error('revoke failed');
      },
    },
    deliveredResultIds: new Set(boundary ? scenario === 'delivered-boundary' ? ['call_old', 'call_current'] : ['call_old'] : []),
    outstanding: () => pending,
    roundEvents: () => scenario === 'thinking' ? [{ type: 'thinking_delta' }] : scenario === 'native-tool-start' ? [{ type: 'tool_call_start' }] : scenario === 'native-tool-end' ? [{ type: 'tool_call_end' }] : scenario === 'boundary-output' ? [{ type: 'text_delta' }] : [],
    context: { messages: [{ role: 'assistant', content: 'This tool call was blocked by OpenAI because we could not determine its safety status.' }] },
  };
  const oe = { message: 'fixture upstream failure', retryable: scenario.startsWith('upstream-') || scenario === 'persistent-upstream', code: ['missing-assistant', 'ambiguous', 'other-DOM-error'].includes(scenario) ? 'chatgpt_submitted_turn_failed'
    : scenario === 'auth' ? 'chatgpt_session_expired' : scenario === 'context-limit' ? 'context_length_exceeded'
    : ['upstream-error', 'persistent-upstream', 'upstream-after-tools'].includes(scenario) ? 'upstream_server_error' : 'chatgpt_fetch_failed' };
  const re = Error(scenario === 'other-DOM-error' ? 'Some unrelated DOM timeout' : 'ChatGPT accepted the message but did not expose its assistant turn in the DOM');
  if (scenario.startsWith('platform-')) {
    oe.retryable = true;
    oe.code = scenario === 'platform-code' ? 'content_filter' : scenario === 'platform-fetch' ? 'chatgpt_fetch_failed' : 'upstream_server_error';
    if (scenario === 'platform-cause') {
      (re as any).cause = Error("This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.");
    } else if (scenario !== 'platform-code') {
      oe.message = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.";
    }
  }
  if (scenario === 'boundary-platform') oe.message = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.";
  const messages: any[] = boundary ? [
    { role: 'toolResult', toolCallId: 'call_old', content: 'Already executed' },
    { role: 'toolResult', toolCallId: 'call_current', content: 'Completed result', isError: scenario === 'failed-tool-boundary' },
  ] : [];
  if (scenario === 'missing-old-result') messages.shift();
  if (scenario === 'missing-current-result') messages.pop();
  if (scenario === 'duplicate-current-result') messages.push({ ...messages[1] });
  if (scenario === 'foreign-result') messages[1].toolCallId = 'call_unknown';
  const y = { abortSignal: controller.signal }, f = { _compactionRequest: scenario === 'compaction', context: { messages } };
  const failedAttempts = scenario === 'recover-second' ? 2 : scenario.startsWith('persistent') ? 20 : 1;
  const execute = new Function('chatGptFetchRecoveryEligible', 'chatGptPlatformToolBlocked', 'chatGptFetchRecoveryDecision', 'O', 'oe', 're', 'U', 'y', 'f', 'De', 'be', 'Hn', 'D', 'eo', 'setTimeout', 'P', 'T', 'clearInterval', 'console', 'onAttempt', 'onTerminal', 'onSuccess', `return (async()=>{
    let fetchRecoveryAttempts=0,fetchRecoveryRequested=false,calls=0;
    let B=async()=>{calls++;onAttempt();if(calls<=${failedAttempts}){${branch}onTerminal();return;}onSuccess();};
    ${loop}
    return {calls,retries:fetchRecoveryAttempts};
  })()`);
  let result: any, failure: any;
  try {
    const blocked = new Function(`${source.slice(helperStart, helperEnd)};return chatGptPlatformToolBlocked`)();
    const decision = new Function(`${source.slice(helperStart, helperEnd)};return chatGptFetchRecoveryDecision`)();
    result = await execute(eligible, blocked, decision, O, oe, re, 'round', y, f,
      { retire: () => operations.push('evict'), retireAndWait: async () => { operations.push('retire'); if (scenario === 'abort-retirement') controller.abort(); } },
      'execution', { clear: () => {} }, 'retry-key',
      async (promise: Promise<unknown>, signal: AbortSignal) => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); return promise; },
      (resolve: () => void, delay: number) => { delays.push(delay); operations.push('delay'); if (scenario === 'abort-delay') controller.abort(); resolve(); },
      () => {}, {}, () => { cleared++; }, { warn: () => {} },
      () => operations.push('attempt'), () => { terminal++; }, () => { successes++; },
    );
  } catch (error) { failure = error; }
  const recover = ['recover-first', 'recover-second', 'missing-assistant', 'upstream-error', 'quoted-history', 'completed-boundary', 'failed-tool-boundary', 'delivered-boundary'].includes(scenario);
  if (recover) {
    const retryCount = scenario === 'recover-second' ? 2 : 1;
    assert.equal(result.retries, retryCount);
    assert.equal(result.calls, retryCount + 1);
    assert.equal(successes, 1); assert.equal(terminal, 0);
    assert.deepEqual(delays, retryCount === 2 ? [2000, 5000] : [2000]);
    assert.deepEqual(operations, retryCount === 2
      ? ['attempt', 'revoke', 'retire', 'delay', 'attempt', 'revoke', 'retire', 'delay', 'attempt']
      : ['attempt', 'revoke', 'retire', 'delay', 'attempt']);
  } else if (scenario.startsWith('persistent')) {
    assert.equal(result.calls, 3); assert.equal(result.retries, 2);
    assert.equal(terminal, 1); assert.equal(successes, 0); assert.deepEqual(delays, [2000, 5000]);
    assert.equal(oe.retryable, false); assert(oe.message.includes('attempt_budget_exhausted'));
    assert.equal(oe.code, 'chatgpt_recovery_stopped');
  } else if (['abort-delay', 'abort-retirement'].includes(scenario)) {
    assert.equal(failure?.name, 'AbortError'); assert.equal(successes, 0); assert.equal(terminal, 0);
    assert.equal(operations.filter(x => x === 'attempt').length, 1);
  } else if (scenario === 'revoke-failure') {
    assert.equal(failure?.message, 'revoke failed'); assert(!operations.includes('retire'));
  } else {
    assert.equal(result.calls, 1); assert.equal(result.retries, 0); assert.equal(terminal, 1); assert.equal(successes, 0);
    assert.deepEqual(delays, []); assert(!operations.includes('retire'));
    if (scenario === 'upstream-after-tools') assert.equal(oe.retryable, false);
    if (scenario.startsWith('platform-') || scenario === 'boundary-platform') {
      assert.equal(oe.retryable, false);
      assert.equal(oe.code, 'chatgpt_platform_tool_blocked');
      assert.equal((oe as any).status, 403);
    }
  }
  assert.equal(cleared, 1, 'Heartbeat must always be cleaned up');
  console.log(`PASS recovery: ${scenario}`);
}
