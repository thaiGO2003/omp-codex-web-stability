import {expect,test} from 'bun:test';
import {chromium} from 'playwright-core';
import {resolveChatGptToolConfirmation} from '../src/adapters/chatgpt-web/browser-worker';
import {readFileSync} from 'node:fs';

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('owned approval cards handle key hints and preserve human safety decisions',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{
  let resolveApproval=resolveChatGptToolConfirmation;
  if(process.env.CHATGPT_NATIVE_APPROVAL_HELPER){
   const bundle=readFileSync(process.env.CHATGPT_NATIVE_APPROVAL_HELPER,'utf8');const begin=bundle.indexOf('async function Ea('),end=bundle.indexOf('function _a(',begin);
   class AdapterError extends Error {constructor(message:string,options:object){super(message);Object.assign(this,options);}}
   resolveApproval=new Function('P','vo',bundle.slice(begin,end)+';return Ea;')(AdapterError,60000);
  }
  for(const scenario of ['ordinary','wrong-app','permanent-only','warning','late-warning','human-decision','foreign-history','aborted'] as const){
   const page=await browser.newPage();
   const card=(app:string,warning:boolean,permanentOnly=false)=>`<div class="@container/approval-card"><div role="alert"><p>Allow ChatGPT to use ${app}?</p><p>Read the local fixture.</p></div>${warning?'<aside role="alert">Suspicious Instruction: review this tool request.</aside>':''}<form><button type="button">Always allow</button><button type="button">Deny<span> Esc</span></button>${permanentOnly?'':'<button type="button" id="allow">Allow once<span> ⏎</span></button>'}</form></div>`;
   await page.setContent(`<main><div id="history">${card('Codex Native2',false)}</div><div id="current">${scenario==='foreign-history'?'No pending approval.':card(scenario==='wrong-app'?'Other App':'Codex Native2',scenario==='warning'||scenario==='human-decision',scenario==='permanent-only')}</div></main>`);
   await page.evaluate(()=>{(window as any).pressed=[];document.addEventListener('click',event=>{const b=(event.target as HTMLElement).closest('button');if(b){(window as any).pressed.push(b.textContent);b.closest('[class~="@container/approval-card"]')!.remove();}});});
   const pending:boolean[]=[];
   if(scenario==='late-warning')await page.locator('#current #allow').evaluate(b=>{(b as HTMLButtonElement).hidden=true;setTimeout(()=>{const a=document.createElement('aside');a.setAttribute('role','alert');a.textContent='Suspicious Instruction';b.closest('[class~="@container/approval-card"]')!.prepend(a);(b as HTMLButtonElement).hidden=false;},50);});
   const onPending=async(value:boolean)=>{pending.push(value);if(value&&scenario==='human-decision')await page.locator('#current').evaluate(n=>{n.innerHTML='Human decision handled externally.';});};
   const timeout=scenario==='late-warning'?200:5;
   const result=resolveApproval(page.locator('#current'),'Codex Native2',true,scenario==='aborted'?AbortSignal.abort():undefined,timeout,undefined,onPending);
   if(scenario==='warning'||scenario==='late-warning')await expect(result).rejects.toMatchObject({code:'chatgpt_tool_approval_required',retryable:false});
   else if(scenario==='aborted')await expect(result).rejects.toMatchObject({name:'AbortError'});
   else if(scenario==='permanent-only')await expect(result).rejects.toThrow();
   else expect(await result).toBe(scenario==='ordinary'||scenario==='human-decision');
   const pressed=await page.evaluate(()=>(window as any).pressed);
   expect(pressed).toEqual(scenario==='ordinary'?['Allow once ⏎']:[]);
   if(scenario==='warning'||scenario==='late-warning'||scenario==='human-decision')expect(pending).toEqual([true,false]);
   expect(await page.locator('#history [class~="@container/approval-card"]').count()).toBe(1);
   await page.close();
  }
 }finally{await browser.close();}
},60000);
