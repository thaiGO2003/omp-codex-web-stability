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
    const prompt = 'Explain one thing.\nKeep  two spaces.';
    const href = 'app://fixture-connector';
    for (const scenario of ['matching', 'two-separators', 'nbsp-run', 'changed-single-space', 'hydrating', 'wrong-app', 'different-task', 'prefix-only', 'extra-app', 'competing-turn'] as const) {
      const page = await browser.newPage();
      await page.setContent(`<main></main><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px"><span app-mention-path="${href}" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span> ${prompt}</div><button type="submit">Send</button></form>`);
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
      const mention = `<span data-prompt-link-href="${scenario === 'wrong-app' ? 'app://other' : href}">Codex Native2</span>`;
      const gap = scenario === 'two-separators' ? '  ' : ' ';
      let content = `${mention}${gap}${text.replaceAll('\n','<br>')}`;
      if (scenario === 'nbsp-run') content = content.replace('Keep  two', 'Keep\u00a0 two');
      if (scenario === 'changed-single-space') content = content.replace('Explain one', 'Explain\u00a0one');
      if (scenario === 'extra-app') content = mention + content;
      if (scenario === 'hydrating') content = '$codex-native2  ' + text.replaceAll('\n','<br>');
      let replacement = `<div data-turn-key="saved"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap"><p>${content}</p></div><button>Show more</button></div><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Answer.</div><div class="turn-action-controls"><button>Copy</button></div></div>`;
      if (scenario === 'competing-turn') replacement += '<div data-turn-key="other"><div data-user-message-bubble>Other</div></div>';
      await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === 'matching' || scenario === 'two-separators' || scenario === 'nbsp-run') {
        expect((await result).identity).toBe('group:assistant:saved');
      } else if (scenario === 'hydrating') {
        expect(await result).toBe(binding);
        await page.locator('[data-search-result-target] p').evaluate((p, html) => { p.innerHTML = html; }, `${mention}  ${prompt.replaceAll('\n','<br>')}`);
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe('group:assistant:saved');
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30000);
