import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { strict as assert } from 'node:assert';
import { runInNewContext } from 'node:vm';

const root = process.argv[2];
if (!root) throw Error('Pass runtime directory');
class AdapterError extends Error {
  constructor(message: string, fields: Record<string, unknown>) { super(message); Object.assign(this, fields); }
}
for (const name of ['cli.js', 'browser-helper.cjs']) {
  const source = readFileSync(`${root}/app/${name}`, 'utf8');
  new Bun.Transpiler({ loader: 'js' }).transformSync(source);
  const observer = source.match(/class (\w+)\{onRejected;page;generation=0;requests=new Set;streams=new Map;checks=\[\];[^]*?\}\}async function/);
  if (!observer) throw Error(`${name}: observer missing`);
  const definition = observer[0].slice(0, -'async function'.length);
  const errorClass = definition.match(/new (\w+)\("ChatGPT conversation request failed/)?.[1];
  const timeout = definition.match(/this\.checks\.push\((\w+)\(e,3000\)/)?.[1];
  if (!errorClass || !timeout) throw Error('Observer dependencies missing');
  const Observer = new Function(errorClass, timeout, `${definition};return ${observer[1]}`)(AdapterError, (p: Promise<unknown>) => p);
  for (const scenario of ['owned', 'stream', 'unrelated-url', 'other-frame', 'other-method', 'cancelled', 'disposed', 'finished', 'size-json', 'size-sse']) {
    const page = new EventEmitter() as EventEmitter & { mainFrame: () => object };
    const frame = {};
    page.mainFrame = () => frame;
    const errors: any[] = [];
    const tracked = new Observer((error: unknown) => errors.push(error));
    tracked.begin(page);
    const request = {
      method: () => scenario === 'other-method' ? 'GET' : 'POST',
      url: () => scenario === 'unrelated-url' ? 'https://chatgpt.com/backend-api/me' : 'https://chatgpt.com/backend-api/f/conversation',
      frame: () => scenario === 'other-frame' ? {} : frame,
      failure: () => ({ errorText: scenario === 'cancelled' ? 'net::ERR_ABORTED' : 'net::ERR_CONNECTION_RESET private-url' }),
    };
    page.emit('request', request);
    if (['stream', 'finished', 'size-json', 'size-sse'].includes(scenario)) {
      page.emit('response', {
        request: () => request,
        status: () => scenario === 'size-json' ? 413 : 200,
        headers: () => ({ 'content-type': scenario === 'size-json' ? 'application/json' : 'text/event-stream' }),
        json: async () => ({ detail: { code: 'message_length_exceeds_limit' } }),
        text: async () => scenario === 'size-sse'
          ? 'data: {"error_code":"input_too_large","error_reason":"last_user_message","error":"too large"}\n\n'
          : 'data: [DONE]\n\n',
      });
    }
    if (scenario === 'disposed') tracked.dispose();
    if (['finished', 'size-sse'].includes(scenario)) page.emit('requestfinished', request);
    else page.emit('requestfailed', request);
    const failure = await tracked.failure();
    if (['owned', 'stream'].includes(scenario)) {
      assert.equal(failure?.code, 'chatgpt_fetch_failed');
      assert.equal(failure.retryable, false);
      assert.equal(errors.length, 1);
      assert(!failure.message.includes('private-url'));
      page.emit('requestfailed', request);
      assert.equal(errors.length, 1);
    } else if (scenario.startsWith('size-')) {
      assert.equal(failure?.code, 'context_length_exceeded');
      assert.equal(failure.retryable, false);
    } else {
      assert.equal(failure, undefined);
      assert.equal(errors.length, 0);
    }
    tracked.dispose();
    assert.equal(page.eventNames().length, 0);
    console.log(`PASS ${name}: transport/${scenario}`);
  }
  const start = source.indexOf('async waitForNewAssistantTurn(');
  const end = source.indexOf('async reconcileAssistantTurnBinding(', start);
  const method = source.slice(start, end);
  const deps = name === 'cli.js'
    ? ['ja', 'yt', 'Ft', 'Ct', 'di', 'Zr', 'Cl', 'Yr', 'Xn', 'kl', 'q']
    : ['dr', 'Fe', 'Re', 'we', 'Rt', 'ft', 'Zr', 'gt', 'Je', 'rn', 'S'];
  let externalLive = false;
  const Waiter = new Function(...deps, `return class {${method}}`)(
    120000, () => Error('tab closed'), async () => {}, async () => {}, class ObservationTimeout extends Error {},
    2, () => externalLive, (_baseline: unknown, ids: string[]) => ids[0], (id: string) => id,
    () => externalLive, AdapterError,
  );
  for (const scenario of ['fresh', 'stale', 'other-user', 'generating', 'tools-live', 'aborted', 'assistant-present', 'unbound']) {
    const waiter = new Waiter();
    const baseline = { initialTurnIdentities: [], initialFetchFailureVisible: scenario === 'stale', acceptedUserIdentity: scenario === 'unbound' ? undefined : 'owned-user', domCache: {} };
    const state = { fetchFailureVisible: true, userIdentities: scenario === 'other-user' ? ['other'] : ['owned-user'], responseIdentities: scenario === 'assistant-present' ? ['assistant'] : [], turnIdentities: ['owned-user'], visibleStopButtonCount: scenario === 'generating' ? 1 : 0 };
    waiter.submissionDomState = async () => state;
    waiter.reconcileMultipartHistory = async () => {};
    const waiting = Error('still waiting');
    waiter.waitForTurnDomOrExternalProgress = async () => { throw waiting; };
    externalLive = scenario === 'tools-live';
    let failure: any, binding: any;
    try {
      binding = await waiter.waitForNewAssistantTurn({ isClosed: () => false, locator: (id: string) => id }, baseline, undefined, scenario === 'aborted' ? AbortSignal.abort() : undefined);
    } catch (error) { failure = error; }
    if (scenario === 'fresh') {
      assert.equal(failure?.code, 'chatgpt_fetch_failed');
      assert.equal(failure.retryable, false);
    } else if (scenario === 'aborted') assert.equal(failure?.name, 'AbortError');
    else if (scenario === 'assistant-present') assert.equal(binding.identity, 'assistant');
    else assert.equal(failure, waiting);
    console.log(`PASS ${name}: UI/${scenario}`);
  }
  const domStart = source.indexOf('async submissionDomState(');
  const domEnd = source.indexOf('async ', domStart + 'async submissionDomState('.length);
  const domMethod = source.slice(domStart, domEnd);
  const filter = domMethod.match(/attributeFilter:\[\.\.\.(\w+)\]/)?.[1];
  const selectors = ['userTurnSelector', 'assistantTurnSelector', 'stopButtonSelector'].map(key => domMethod.match(new RegExp(key + ':(\\w+)'))?.[1]);
  assert(filter && selectors.every(Boolean));
  const primitives = name === 'cli.js' ? ['je', '_t', 'Be'] : ['X', 'Ce', 'U'];
  const Dom = new Function(...primitives, filter!, ...selectors as string[], `return class {${domMethod}}`)(
    () => {}, (p: Promise<unknown>) => p, (p: Promise<unknown>) => p, [], 'USER', 'ASSISTANT', 'STOP',
  );
  for (const scenario of ['visible-alert', 'hidden-alert', 'ordinary-text', 'unrelated-alert']) {
    const alert = { isConnected: true, textContent: scenario === 'unrelated-alert' ? 'Account updated' : 'Failed to fetch',
      getBoundingClientRect: () => ({ width: scenario === 'hidden-alert' ? 0 : 20, height: scenario === 'hidden-alert' ? 0 : 20 }) };
    const page = { evaluate: async (fn: Function, args: unknown) => runInNewContext(`(${fn.toString()})(args)`, {
      args, performance: { timeOrigin: 1 }, MutationObserver: class { observe() {} },
      getComputedStyle: () => ({ visibility: 'visible' }),
      document: { documentElement: {}, querySelectorAll: (selector: string) => selector === '[role="alert"]' && scenario !== 'ordinary-text' ? [alert] : [] },
    }) };
    const snapshot = await new Dom().submissionDomState(page, {});
    assert.equal(snapshot.fetchFailureVisible, scenario === 'visible-alert');
    console.log(`PASS ${name}: DOM/${scenario}`);
  }
  // A dropped transport is ambiguous. Preserve server-side generation; user cancellation still stops it.
  const cancel = source.match(/if\(e\.abortSignal\?\.aborted\)\{if\(e\.abortSignal\.reason\?\.code==="chatgpt_fetch_failed"\)[^]*?throw new DOMException\("ChatGPT web turn aborted","AbortError"\)\}/);
  assert(cancel, 'Cancellation guard missing');
  const stopBinding = cancel[0].match(/let (\w+)=(\w+)\((\w+)\)/)!;
  const cancelTurn = new Function('e', stopBinding[2], stopBinding[3], `return (async()=>{${cancel[0]}})()`);
  for (const scenario of ['fetch', 'user']) {
    const reason = Object.assign(Error(scenario), { code: scenario === 'fetch' ? 'chatgpt_fetch_failed' : 'client_cancelled' });
    let stops = 0, failure: any;
    try {
      await cancelTurn({ abortSignal: { aborted: true, reason } }, () => ({ isVisible: async () => true, press: async () => { stops++; } }), {});
    } catch (error) { failure = error; }
    assert.equal(stops, scenario === 'fetch' ? 0 : 1);
    if (scenario === 'fetch') assert.equal(failure, reason);
    else assert.equal(failure.name, 'AbortError');
    console.log(`PASS ${name}: cancellation/${scenario}`);
  }
}
