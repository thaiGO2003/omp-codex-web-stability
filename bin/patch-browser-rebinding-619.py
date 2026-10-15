#!/usr/bin/env python3
"""Preserve complete-prompt/connector ownership on verified 6.1.9 Linux bundles."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rebinding_base', ROOT / 'bin/patch-browser-rebinding-617.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def replacements(name):
    comparator = json.loads((ROOT / 'fixes/browser-rebinding.json').read_text())['patches'][0]['new']
    if name == 'cli.js':
        old_compare = 'p.evaluate((h,m)=>{let f=h.querySelectorAll("[data-user-message-bubble]"),w=f.length===1?f[0].querySelectorAll("[data-search-result-target]"):[],y=(g)=>g.replace(/\\r\\n?/g,`\n`);return w.length===1&&y(w[0].innerText)===y(m)},t.submittedText)'
        comparator = comparator.replace('m.evaluate(', 'p.evaluate(', 1)
        old_send = 'async sendAttachedPrompt(e,t,n,r,o,i,a,s){let l=(await this.activeComposer(e)).locator("xpath=ancestor::form[1]").locator(Us);'
        wait, abort, signal, selector = 'wt', 'Re', 'r', 'Us'
        match, binding, replacement = 'd', 'n', 's'
        send_args = 'e,t,n,r,o,i,a,s'
    elif name == 'browser-helper.cjs':
        old_compare = 'm.evaluate((b,f)=>{let v=b.querySelectorAll("[data-user-message-bubble]"),P=v.length===1?v[0].querySelectorAll("[data-search-result-target]"):[],S=(W)=>W.replace(/\\r\\n?/g,`\n`);return P.length===1&&S(P[0].innerText)===S(f)},t.submittedText)'
        old_send = 'async sendAttachedPrompt(e,t,r,n,o,i,s,a){let l=(await this.activeComposer(e)).locator("xpath=ancestor::form[1]").locator(Hr);'
        wait, abort, signal, selector = 'we', 'V', 'n', 'Hr'
        match, binding, replacement = 'p', 'r', 'a'
        send_args = 'e,t,r,n,o,i,s,a'
    else:
        raise ValueError('Unknown bundle')
    new_send = (f'async sendAttachedPrompt({send_args}){{let composer=await this.activeComposer(e);'
                f't.submittedAppMentionHref=await {wait}({abort}(composer.evaluate((element,appName)=>{{'
                'const mentions=[...element.querySelectorAll(\'[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]\')]'
                '.filter(node=>node.getAttribute("app-mention-display-name")===appName);'
                'return mentions.length===1?mentions[0].getAttribute("app-mention-path")??undefined:undefined'
                f'}},this.config.appName),{signal}));let l=composer.locator("xpath=ancestor::form[1]").locator({selector});')
    error = 'ChatGPT opened another user turn while the bound assistant response was detached'
    old_guard = f'if(!{match})throw Error("{error}")'
    new_guard = (f'if({match}==="pending")return {binding};if(!{match})throw Error("{error}"'
                 f'+` (replacement=${{Boolean({replacement})}}, acceptedUser=${{Boolean(t.acceptedUserIdentity)}},'
                 ' sameUser=${l===t.acceptedUserIdentity}, appBound=${Boolean(t.submittedAppMentionHref)},'
                 ' submittedChars=${t.submittedText?.length??0})`)')
    return [(old_compare, comparator), (old_guard, new_guard), (old_send, new_send)]


def patch_text(source, name):
    return base.patch_text(source, name, replacements)


def main():
    base.main('6.1.9', replacements)


if __name__ == '__main__':
    main()
