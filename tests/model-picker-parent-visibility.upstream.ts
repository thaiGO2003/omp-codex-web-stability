import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { selectChatGptModelFamily } from '../src/adapters/chatgpt-web/model-selection';
import { ChatGptWebAdapterError } from '../src/adapters/chatgpt-web/adapter-error';

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('model selection uses the active parent view and rejects hidden or ambiguous toggles', async () => {
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try {
  let select=selectChatGptModelFamily;
  if (process.env.CHATGPT_NATIVE_MODEL_HELPER) {
   const bundle=readFileSync(process.env.CHATGPT_NATIVE_MODEL_HELPER,'utf8');
   const begin=bundle.indexOf('function Wr('),end=bundle.indexOf('function ia(',begin);
   if(begin<0||end<0)throw Error('Unknown native model-selection layout');
   select=new Function('P','$e',bundle.slice(begin,end)+';return uo;')(ChatGptWebAdapterError,(family:string,cause:unknown)=>new ChatGptWebAdapterError(`ChatGPT model ${family} could not be selected and verified.`,{status:400,errorType:'invalid_request_error',code:'model_version_unavailable',retryable:false,cause}));
  }
  for(const scenario of ['parent','legacy','hidden-own','hidden-parent','duplicate','foreign'] as const) {
   const page=await browser.newPage();page.setDefaultTimeout(2000);
   const toggle=`<div data-model-picker-view-toggle="true" ${scenario==='legacy'?'aria-hidden="false"':scenario==='hidden-own'?'aria-hidden="true"':''} role="menuitem" tabindex="0">Select model</div>`;
   await page.setContent(`<form><div id="draft" contenteditable="true">Unsent draft</div><button type="submit">Send</button></form>
    <div role="menu" id="owned"><div data-model-picker-view="simple">
     <div id="simple" aria-hidden="${scenario==='hidden-parent'?'true':'false'}">${scenario==='foreign'?'':toggle}${scenario==='duplicate'?toggle:''}</div>
     <div id="models" aria-hidden="true" inert><div role="menuitemradio" aria-checked="true">6</div><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
     <div aria-hidden="true" inert>${toggle}</div>
    </div></div><div role="menu">${toggle}</div>
    <script>
     window.sent=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.sent++};
     document.querySelectorAll('#simple [data-model-picker-view-toggle]').forEach(n=>n.onclick=()=>{const m=document.querySelector('#models');m.removeAttribute('inert');m.setAttribute('aria-hidden','false');document.querySelector('[data-model-picker-view]').setAttribute('data-model-picker-view','advanced')});
     document.querySelectorAll('#models [role=menuitemradio]')[1].onclick=()=>{document.querySelectorAll('#models [role=menuitemradio]').forEach((n,i)=>n.setAttribute('aria-checked',String(i===1)))};
    </script>`);
   const menu={menu:page.locator('#owned')} as Parameters<typeof select>[0];
   if(scenario==='parent'||scenario==='legacy')expect(await select(menu,'5.6',async()=>menu)).toBe(menu);
   else await expect(select(menu,'5.6',async()=>menu)).rejects.toMatchObject({code:'model_version_unavailable'});
   expect(await page.locator('#draft').innerText()).toBe('Unsent draft');
   expect(await page.evaluate(()=>(window as any).sent)).toBe(0);
   await page.close();
  }
 } finally {await browser.close();}
},60000);
