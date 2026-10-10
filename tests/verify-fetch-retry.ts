import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = process.argv[2];
if (!root) throw Error('Pass runtime directory');
const source = readFileSync(`${root}/app/cli.js`, 'utf8');
new Bun.Transpiler({ loader: 'js' }).transformSync(source);
const helperStart = source.indexOf('function chatGptFetchRecoveryEligible(');
const helperEnd = source.indexOf('function x_(', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart);
const eligible = new Function(`${source.slice(helperStart, helperEnd)};return chatGptFetchRecoveryEligible`)();
const branchStart = source.indexOf('if(fetchRecoveryAttempts<2&&chatGptFetchRecoveryEligible(');
const branchEnd = source.indexOf('let C=oe instanceof q&&oe.retryable?', branchStart);
assert(branchStart >= 0 && branchEnd > branchStart);
const branch = source.slice(branchStart, branchEnd);
const loopStart = source.indexOf('try{P({type:"heartbeat"});for(;;){fetchRecoveryRequested=false;await B();');
const loopEnd = source.indexOf('finally{clearInterval(T)}', loopStart) + 'finally{clearInterval(T)}'.length;
assert(loopStart >= 0 && loopEnd > loopStart);
const loop = source.slice(loopStart, loopEnd);

for (const scenario of ['recover-first', 'recover-second', 'persistent', 'persistent-upstream', 'upstream-after-tools', 'missing-assistant', 'upstream-error', 'tools-ran', 'tools-active', 'pending-tool', 'output', 'thinking', 'cancelled', 'abort-delay', 'abort-retirement', 'revoke-race', 'revoke-failure', 'manual', 'compaction', 'ambiguous', 'auth', 'context-limit', 'other-DOM-error']) {
  const operations: string[] = [], delays: number[] = [];
  let terminal = 0, successes = 0, cleared = 0;
  const controller = new AbortController();
  const progress = { lastToolBatchRevision: ['tools-ran', 'upstream-after-tools'].includes(scenario) ? 1 : 0, activeToolCalls: scenario === 'tools-active' ? 1 : 0 };
  if (scenario === 'cancelled') controller.abort();
  const O = {
    runtime: {
      mode: 'tools', manualControl: scenario === 'manual', submission: { phase: scenario === 'ambiguous' ? 'send_activated' : 'accepted' },
      text: { value: () => scenario === 'output' ? 'Existing answer' : '' },
      externalProgress: { snapshot: () => ({ ...progress }) },
      retireCapability: async () => {
        operations.push('revoke');
        if (scenario === 'revoke-race') progress.lastToolBatchRevision = 1;
        if (scenario === 'revoke-failure') throw Error('revoke failed');
      },
    },
    outstanding: () => scenario === 'pending-tool' ? [{}] : [],
    roundEvents: () => scenario === 'thinking' ? [{ type: 'thinking_delta' }] : [],
  };
  const oe = { message: 'fixture upstream failure', retryable: scenario.startsWith('upstream-') || scenario === 'persistent-upstream', code: ['missing-assistant', 'ambiguous', 'other-DOM-error'].includes(scenario) ? 'chatgpt_submitted_turn_failed'
    : scenario === 'auth' ? 'chatgpt_session_expired' : scenario === 'context-limit' ? 'context_length_exceeded'
    : ['upstream-error', 'persistent-upstream', 'upstream-after-tools'].includes(scenario) ? 'upstream_server_error' : 'chatgpt_fetch_failed' };
  const re = Error(scenario === 'other-DOM-error' ? 'Some unrelated DOM timeout' : 'ChatGPT accepted the message but did not expose its assistant turn in the DOM');
  const y = { abortSignal: controller.signal }, f = { _compactionRequest: scenario === 'compaction' };
  const failedAttempts = scenario === 'recover-second' ? 2 : scenario.startsWith('persistent') ? 20 : 1;
  const execute = new Function('chatGptFetchRecoveryEligible', 'O', 'oe', 're', 'U', 'y', 'f', 'De', 'be', 'Hn', 'D', 'eo', 'setTimeout', 'P', 'T', 'clearInterval', 'console', 'onAttempt', 'onTerminal', 'onSuccess', `return (async()=>{
    let fetchRecoveryAttempts=0,fetchRecoveryRequested=false,calls=0;
    let B=async()=>{calls++;onAttempt();if(calls<=${failedAttempts}){${branch}onTerminal();return;}onSuccess();};
    ${loop}
    return {calls,retries:fetchRecoveryAttempts};
  })()`);
  let result: any, failure: any;
  try {
    result = await execute(eligible, O, oe, re, 'round', y, f,
      { retireAndWait: async () => { operations.push('retire'); if (scenario === 'abort-retirement') controller.abort(); } },
      'execution', { clear: () => {} }, 'retry-key',
      async (promise: Promise<unknown>, signal: AbortSignal) => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); return promise; },
      (resolve: () => void, delay: number) => { delays.push(delay); operations.push('delay'); if (scenario === 'abort-delay') controller.abort(); resolve(); },
      () => {}, {}, () => { cleared++; }, { warn: () => {} },
      () => operations.push('attempt'), () => { terminal++; }, () => { successes++; },
    );
  } catch (error) { failure = error; }
  const recover = ['recover-first', 'recover-second', 'missing-assistant', 'upstream-error'].includes(scenario);
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
    assert.equal(oe.retryable, false); assert(oe.message.includes('after 2 automatic retries'));
  } else if (['abort-delay', 'abort-retirement'].includes(scenario)) {
    assert.equal(failure?.name, 'AbortError'); assert.equal(successes, 0); assert.equal(terminal, 0);
    assert.equal(operations.filter(x => x === 'attempt').length, 1);
  } else if (scenario === 'revoke-failure') {
    assert.equal(failure?.message, 'revoke failed'); assert(!operations.includes('retire'));
  } else {
    assert.equal(result.calls, 1); assert.equal(result.retries, 0); assert.equal(terminal, 1); assert.equal(successes, 0);
    assert.deepEqual(delays, []); assert(!operations.includes('retire'));
    if (scenario === 'upstream-after-tools') assert.equal(oe.retryable, false);
  }
  assert.equal(cleared, 1, 'Heartbeat must always be cleaned up');
  console.log(`PASS recovery: ${scenario}`);
}
