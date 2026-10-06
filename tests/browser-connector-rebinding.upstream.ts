import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, chatGptReboundTurnIdentity } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptAssistantTurnSelector } from "../src/chatgpt-session";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("submitted connector survives optimistic-to-saved turn replacement", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { appName: "Codex Native2" };
    if (process.env.CHATGPT_NATIVE_REBINDING_HELPER) {
      const bundle = readFileSync(process.env.CHATGPT_NATIVE_REBINDING_HELPER, 'utf8');
      const begin = bundle.indexOf('async reconcileAssistantTurnBinding(');
      const end = bundle.indexOf('async attachedPromptText(', begin);
      if (begin < 0 || end < 0) throw new Error('Unknown native helper method layout');
      worker.reconcileAssistantTurnBinding = new Function('xe', 'j', 'Ia', 'Ke',
        `return (class {${bundle.slice(begin, end)}}).prototype.reconcileAssistantTurnBinding`)(
          (promise: unknown) => promise, (promise: unknown) => promise,
          chatGptReboundTurnIdentity, chatGptAssistantTurnSelector,
        );
    }
    const prompt = 'Explain one thing.\nKeep  two spaces.\nJSON: {"note":"`code` *star* <tag>","path":"C:\\work","literal":"\\n"}';
    const href = 'app://fixture-connector';
    const html = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');
    for (const scenario of ['escaped-markdown', 'escaped-changed-task', 'escaped-wrong-app', 'escaped-letter', 'changed-json-escape', 'matching', 'two-separators', 'nbsp-run', 'changed-single-space', 'hydrating', 'wrong-app', 'different-task', 'prefix-only', 'extra-app', 'competing-turn'] as const) {
      const page = await browser.newPage();
      await page.setContent(`<main></main><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px"><span app-mention-path="${href}" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span> ${html(prompt)}</div><button type="submit">Send</button></form>`);
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator('form').evaluate(form => form.addEventListener('submit', event => {
        event.preventDefault();
        document.querySelector('main')!.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>';
      }));
      expect(await worker.sendAttachedPrompt(page, baseline)).toBe('assistant_turn');
      expect(baseline.submittedAppMentionHref).toBe(href);
      expect(baseline.acceptedUserIdentity).toBeUndefined();
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      const text = scenario === 'different-task' ? 'Different task.' : scenario === 'prefix-only' ? prompt + ' Extra task.' : prompt;
      const mention = `<span data-prompt-link-href="${scenario === 'wrong-app' || scenario === 'escaped-wrong-app' ? 'app://other' : href}">Codex Native2</span>`;
      const escape = (value: string) => value.replace(/[\\`*_<:>"\[\]]/g, '\\$&');
      const savedText = scenario.startsWith('escaped-') ? escape(text) : text;
      const renderedText = scenario === 'escaped-changed-task' ? savedText.replace('Explain','Delete')
        : scenario === 'escaped-letter' ? '\\' + savedText
        : scenario === 'changed-json-escape' ? savedText.replace('\\n"}', '\\t"}') : savedText;
      const gap = scenario === 'two-separators' ? '  ' : ' ';
      let content = `${mention}${gap}${html(renderedText)}`;
      if (scenario === 'nbsp-run') content = content.replace('Keep  two', 'Keep\u00a0 two');
      if (scenario === 'changed-single-space') content = content.replace('Explain one', 'Explain\u00a0one');
      if (scenario === 'extra-app') content = mention + content;
      if (scenario === 'hydrating') content = '$codex-native2  ' + html(text);
      let replacement = `<div data-turn-key="saved"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap"><p>${content}</p></div><button>Show more</button></div><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Answer.</div><div class="turn-action-controls"><button>Copy</button></div></div>`;
      if (scenario === 'competing-turn') replacement += '<div data-turn-key="other"><div data-user-message-bubble>Other</div></div>';
      await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === 'escaped-markdown' || scenario === 'matching' || scenario === 'two-separators' || scenario === 'nbsp-run') {
        expect((await result).identity).toBe('group:assistant:saved');
      } else if (scenario === 'hydrating') {
        expect(await result).toBe(binding);
        await page.locator('[data-search-result-target] p').evaluate((p, html) => { p.innerHTML = html; }, `${mention}  ${html(prompt)}`);
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe('group:assistant:saved');
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("hydrated app pill layout preserves a 199K submitted payload across saved-turn replacement", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    if (process.env.CHATGPT_NATIVE_REBINDING_HELPER) {
      const bundle = readFileSync(process.env.CHATGPT_NATIVE_REBINDING_HELPER, 'utf8');
      const begin = bundle.indexOf('async reconcileAssistantTurnBinding(');
      const end = bundle.indexOf('async attachedPromptText(', begin);
      worker.reconcileAssistantTurnBinding = new Function('xe', 'j', 'Ia', 'Ke',
        `return (class {${bundle.slice(begin, end)}}).prototype.reconcileAssistantTurnBinding`)(
          (promise: unknown) => promise, (promise: unknown) => promise,
          chatGptReboundTurnIdentity, chatGptAssistantTurnSelector,
        );
    }
    const prompt = 'Act as the model backend for the Codex task encoded below.\n'
      + 'serialized JSON preserves  two spaces and literal \\n. '.repeat(4000).slice(0,199000)
      + '\nEnd of complete task context.';
    for (const scenario of ['layout', 'escaped-layout', 'escaped-changed-payload', 'extra-boundary-newline', 'changed-payload-newline', 'prefix-only', 'different-app'] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page,prompt);
      baseline.submittedAppMentionHref = 'app://fixture-connector';
      await page.locator('main').evaluate(main => {
        main.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>';
      });
      const binding = await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
      await page.locator('main').evaluate((main,args) => {
        main.innerHTML = '<div data-turn-key="saved"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap"><p></p></div><button>Show more</button></div><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Answer.</div><div class="turn-action-controls"><button>Copy</button></div></div>';
        const p = main.querySelector('p')!;
        const mention = document.createElement('span');
        mention.setAttribute('data-prompt-link-href',args.scenario==='different-app'?'app://other':'app://fixture-connector');
        mention.style.display='inline-flex';
        const label=document.createElement('span');label.style.display='block';label.textContent='Codex Native2';mention.append(label);p.append(mention);
        if(args.scenario==='extra-boundary-newline')p.append(document.createElement('br'));
        const payload = args.scenario==='changed-payload-newline' ? args.prompt.replace('\n','\n\n')
          : args.scenario==='prefix-only' ? args.prompt+' Extra request.' : args.prompt;
        const escaped = args.scenario.startsWith('escaped-')
          ? payload.replace(/[\\`*_<:>"\[\]]/g, '\\$&') : payload;
        const rendered = args.scenario === 'escaped-changed-payload' ? escaped + ' extra task' : escaped;
        p.append(document.createTextNode('  '));
        rendered.split('\n').forEach((line,index)=>{if(index)p.append(document.createElement('br'));p.append(document.createTextNode(line));});
      },{prompt,scenario});
      expect((await page.locator('[data-search-result-target]').innerText()).startsWith('Codex Native2\n')).toBeTrue();
      const result=worker.reconcileAssistantTurnBinding(page,baseline,binding);
      if(scenario==='layout'||scenario==='escaped-layout')expect((await result).identity).toBe('group:assistant:saved');
      else await expect(result).rejects.toThrow();
      await page.close();
    }
  } finally {await browser.close();}
},30000);
