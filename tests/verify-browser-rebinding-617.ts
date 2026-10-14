import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const runtime = process.argv[2];
if (!runtime || !process.env.CHATGPT_DOM_TEST_BROWSER) throw Error("Pass runtime and set CHATGPT_DOM_TEST_BROWSER");
const unpatched = process.argv.includes("--expect-unpatched");
const { chromium } = require(`${runtime}/app/node_modules/playwright-core`);
const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
let checks = 0;
try {
  for (const name of ["browser-helper.cjs", "cli.js"]) {
    const source = readFileSync(`${runtime}/app/${name}`, "utf8");
    new Bun.Transpiler({ loader: "js" }).transformSync(source);
    const begin = source.indexOf("async reconcileAssistantTurnBinding(");
    const end = source.indexOf("async attachedPromptText(", begin);
    assert(begin >= 0 && end > begin);
    const selector = (identity: string) => `[data-fixture-identity="${identity}"]`;
    const dependencies = name === "cli.js" ? ["_t", "Be", "ox", "Xn"] : ["Ce", "U", "Ua", "Je"];
    const reconcile = new Function(...dependencies, `return (class {${source.slice(begin, end)}}).prototype.reconcileAssistantTurnBinding`)(
      (p: unknown) => p, (p: unknown) => p,
      (_initial: string[], _old: string, current: string[]) => current[0], selector,
    );
    const page = await browser.newPage();
    const baseline: any = { initialTurnIdentities: [], submittedText: "Read task board.\nKeep  two spaces; path C:\\work and `code`.", submittedAppMentionHref: "app://fixture", domCache: {} };
    const binding: any = { identity: "group:assistant:fallback", acceptedTurnIdentities: [], locator: page.locator(selector("group:assistant:fallback")) };
    const state: any = { userIdentities: ["group:user:saved"], responseIdentities: ["group:assistant:saved"], turnIdentities: ["group:user:saved", "group:assistant:saved"] };
    const worker: any = { submissionDomState: async () => state, reconcileMultipartHistory: async () => {}, config: { appName: "Codex Native2" } };
    const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>");
    const scenarios = unpatched ? ["literal", "mention"] : ["literal", "mention", "layout", "escaped", "nested-link", "hydrating", "wrong-app", "changed-task", "extra-task", "duplicate-app", "duplicate-root", "competing-turn", "accepted-same-id", "accepted-foreign-id", "large-layout", "large-changed"];
    for (const scenario of scenarios) {
      baseline.acceptedUserIdentity = scenario === "accepted-same-id" ? "group:user:saved" : scenario === "accepted-foreign-id" ? "group:user:foreign" : undefined;
      baseline.submittedText = scenario.startsWith("large") ? "Complete context.\n" + "preserve  whitespace C:\\work. ".repeat(7000) : "Read task board.\nKeep  two spaces; path C:\\work and `code`.";
      const payload = scenario === "changed-task" ? "Delete task board." : baseline.submittedText + (scenario === "extra-task" || scenario === "large-changed" ? " Extra request." : "");
      const saved = scenario === "escaped" ? payload.replace(/[\\`*_<:>"\[\]]/g, "\\$&") : payload;
      const mention = `<span data-prompt-link-href="${scenario === "wrong-app" ? "app://foreign" : "app://fixture"}"${scenario.includes("layout") || scenario.startsWith("large") ? ' style="display:inline-flex"' : ""}><span${scenario.includes("layout") || scenario.startsWith("large") ? ' style="display:block"' : ""}>Codex Native2</span></span>`;
      let content = scenario === "literal" ? html(payload) : mention + "  " + html(saved);
      if (scenario === "hydrating") content = "$codex-native2  " + html(payload);
      if (scenario === "nested-link") content = content.replace("Read task board.", 'Read <a data-search-result-target><span style="display:block">task board.</span></a>');
      if (scenario === "duplicate-app") content = mention + content;
      await page.setContent(`<main data-fixture-identity="group:assistant:saved"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap"><p>${content}</p></div>${scenario === "duplicate-root" ? '<div data-search-result-target>Foreign root</div>' : ""}</div></main>`);
      state.turnIdentities = ["group:user:saved", "group:assistant:saved", ...(scenario === "competing-turn" ? ["group:user:other"] : [])];
      state.userIdentities = ["group:user:saved", ...(scenario === "competing-turn" ? ["group:user:other"] : [])];
      const result = reconcile.call(worker, page, baseline, binding);
      const reject = unpatched ? scenario === "mention" : ["wrong-app", "changed-task", "extra-task", "duplicate-app", "duplicate-root", "competing-turn", "accepted-foreign-id", "large-changed"].includes(scenario);
      if (reject) await assert.rejects(result, /bound assistant response was detached/);
      else if (scenario === "hydrating") assert.equal(await result, binding);
      else assert.equal((await result).identity, "group:assistant:saved");
      checks++;
    }
    if (!unpatched) {
      // Execute the real pre-Send capture with a browser composer. No Send occurs.
      const start = source.indexOf("async sendAttachedPrompt(");
      const captureStart = source.indexOf("let composer=", start);
      const captureEnd = source.indexOf("let l=composer.locator", captureStart);
      assert(captureStart > start && captureEnd > captureStart);
      const capture = new Function(...dependencies.slice(0, 2), `return async function(e,t,n,r){${source.slice(captureStart, captureEnd)}}`)((p: unknown) => p, (p: unknown) => p);
      worker.activeComposer = async () => page.locator("[contenteditable=true]");
      for (const duplicate of [false, true]) {
        const pill = '<span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span>';
        await page.setContent(`<div contenteditable="true">${pill}${duplicate ? pill : ""}</div>`);
        const captured: any = {};
        await capture.call(worker, page, captured);
        assert.equal(captured.submittedAppMentionHref, duplicate ? undefined : "app://fixture");
        checks++;
      }
    }
    await page.close();
  }
} finally { await browser.close(); }
console.log(`PASS ${checks} compiled browser ownership scenarios (${unpatched ? "original failure reproduced" : "patched"})`);
