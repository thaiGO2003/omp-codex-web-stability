import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = process.argv[2];
if (!root) throw Error('Pass runtime directory');
const source = readFileSync(`${root}/app/cli.js`, 'utf8');
const slice = (start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing compiled region ${start}`);
  return source.slice(a, b);
};
const AdapterError = new Function(`return (${slice('class q extends Error{', 'function Ea(')})`)();
const logs: string[] = [];
const logger = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s) };
const Session = new Function('q', 'console', `${slice('class Vh{', 'class jh{')};return Vh`)(AdapterError, logger);
const helpers = new Function('q', `${slice('function chatGptPlatformToolBlocked(', 'function __(')};return {chatGptPlatformToolBlocked,chatGptFetchRecoveryDecision,chatGptFetchRecoveryEligible,x_}`)(AdapterError);
const emitters = new Function('ph', `${slice('function Ef(', 'function chatGptPlatformToolBlocked(')};return {Ef,au,kf,os,Pf,C_}`)(() => undefined);
const prefix = 'return{name:"chatgpt-web",async runTurn(f,y,P){';
const a = source.indexOf(prefix) + prefix.length;
const marker = 'finally{clearInterval(T)}';
const b = source.indexOf(marker, a) + marker.length;
assert(a >= prefix.length && b > a);
// Only local compiled adapter code runs here. Browser and broker transports are
// fixtures; real session journals, early-settlement handling and retry loop run.
const run = new Function('deps', 'f', 'P', `with(deps){return (async function(f,y,P){${source.slice(a, b)}})(f,{},P);}`);

for (const scenario of ['completed-result', 'failed-result', 'missing-result', 'missing-history', 'round-tool-output', 'new-batch-race', 'retirement-race', 'platform-rejection']) {
  logs.length = 0;
  const messages = [
    { role: 'assistant', content: 'Earlier commentary' },
    { role: 'toolResult', toolCallId: 'call_old', content: 'Saved prior write result' },
    { role: 'toolResult', toolCallId: 'call_pending', content: 'Saved find result', isError: scenario === 'failed-result' },
  ];
  if (scenario === 'missing-result') messages.pop();
  if (scenario === 'missing-history') messages.splice(1, 1);
  const f = { modelId: 'chatgpt-web/gpt-5.6-sol', options: { reasoning: 'low' }, context: { messages }, _rawBody: { input: structuredClone(messages) } };
  const before = structuredClone(f);
  const events: any[] = [], builds: any[] = [], delays: number[] = [];
  let completedTools = 0, revocations = 0;
  const progress = { lastToolBatchRevision: 9, activeToolCalls: 1 };
  const failure = new AdapterError(scenario === 'platform-rejection'
    ? "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request."
    : 'ChatGPT conversation request failed in the browser (network_error). The prompt may already have reached ChatGPT.',
    { status: 502, errorType: 'server_error', code: scenario === 'platform-rejection' ? 'upstream_server_error' : 'chatgpt_fetch_failed', retryable: false });
  const runtime = {
    mode: 'tools', token: Promise.resolve('old-capability'), browser: Promise.reject(failure), physicalSettlement: Promise.resolve(),
    text: { value: () => 'Earlier commentary', drain: () => [] }, trace: { drain: () => [] }, submission: { phase: 'accepted' },
    externalProgress: { snapshot: () => ({ ...progress }) },
    retireCapability: async () => {
      revocations++;
      progress.activeToolCalls = 0;
      if (scenario === 'new-batch-race') progress.lastToolBatchRevision++;
    }, cancel: () => {},
  };
  const old = new Session(runtime, 'old-trace', 'owner', 'turn', 'thread', {});
  old.deliveredResultIds.add('call_old');
  old.setOutstanding([{ callId: 'call_pending', wireName: 'find' }]);
  old.appendRoundEvents('round-before', [{ type: 'tool_call_start', id: 'call_pending' }, { type: 'done', stopReason: 'tool_use' }]);
  old.completeRound('round-before');
  if (scenario === 'round-tool-output') old.appendRoundEvent('round-current', { type: 'tool_call_start', id: 'call_new' });
  // Do not use the automatic settled-capability timer for the race fixture:
  // the adapter's explicit revocation must introduce the competing batch.
  old.capabilityRetirementScheduled = true;
  await old.browserOutcome;
  let entry: any = old;
  const registry = {
    getOrCreateAfterOwnerRetirement: async (_key: string, _owner: string, create: () => any) => {
      if (!entry) {
        entry = new Session(create(), 'replacement', 'owner', 'turn', 'thread', {});
        await entry.browserOutcome;
      }
      return entry;
    },
    retireAndWait: async () => { await entry.physicalSettlement; if (scenario === 'retirement-race') progress.lastToolBatchRevision++; entry = undefined; },
    retire: () => { entry = undefined; },
  };
  const deps = {
    ...helpers, ...emitters, q: AdapterError, console: logger,
    Et: () => false, u: false, l: {}, st: () => ({ localTools: true }), Bh: () => undefined, p: 'provider',
    zh: () => 'budget', m: { resolve: () => ({}) }, Xa: () => 'execution', Ul: () => 'owner',
    he: () => ({ turnId: 'turn', threadId: 'thread' }), su: () => 'trace', e: {}, qh: () => ({}), Uh: () => 'round-current', De: registry,
    Hn: { exhaustedError: () => undefined, clear: () => {}, recordRetryableFailure: (_key: string, error: Error) => error },
    r: { revoke: async () => {}, completeTool: async () => { completedTools++; throw Error('Cannot deliver a tool to a dead browser'); } },
    b: (parsed: unknown) => {
      builds.push(structuredClone(parsed));
      return { mode: 'tools', token: Promise.resolve('new-capability'), browser: Promise.resolve('RESUMED_WITH_RESULTS'), physicalSettlement: Promise.resolve(),
        text: { value: () => 'RESUMED_WITH_RESULTS', drain: () => ['RESUMED_WITH_RESULTS'] }, trace: { drain: () => [] },
        externalProgress: { snapshot: () => ({ lastToolBatchRevision: 0, activeToolCalls: 0 }) }, cancel: () => {}, submission: { phase: 'accepted' } };
    },
    Tt: async (promise: Promise<unknown>) => promise, eo: async (promise: Promise<unknown>) => promise,
    w: (parsed: unknown) => parsed, to: () => ({}), c: false, s: false,
    setInterval: () => 0, clearInterval: () => {}, E_: 10000,
    setTimeout: (resolve: () => void, delay: number) => { delays.push(delay); resolve(); },
  };
  await run(deps, f, (event: unknown) => events.push(event));
  assert.deepEqual(f, before, 'Input history and tool result error flags must survive recovery');
  assert.equal(completedTools, 0, 'Never replay or redeliver executed tools to the failed browser');
  if (['completed-result', 'failed-result'].includes(scenario)) {
    assert.equal(builds.length, 1);
    assert.deepEqual(builds[0], before, 'Replacement receives complete original context');
    assert(revocations > 0);
    assert.deepEqual(delays, [2000]);
    assert(events.some(e => e.type === 'text_delta' && e.text === 'RESUMED_WITH_RESULTS'));
    assert(!events.some(e => e.type === 'error'));
    assert(!events.some(e => e.type === 'tool_call_start'));
    assert.equal(events.at(-1).stopReason, 'stop');
  } else {
    assert.equal(builds.length, 0);
    assert.deepEqual(delays, []);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    assert.equal(events.at(-1).code, scenario === 'platform-rejection' ? 'chatgpt_platform_tool_blocked' : 'chatgpt_recovery_stopped');
  }
  console.log(`PASS native continuation: ${scenario}`);
}
