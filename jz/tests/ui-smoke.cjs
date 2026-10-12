const {parseHTML}=require('linkedom');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {window}=parseHTML(fs.readFileSync(root+'/index.html','utf8'));
const {document}=window;let raw=null;
const storage={getItem:()=>raw,setItem:(k,v)=>raw=v};
const modal=document.querySelector('#modal');modal.showModal=function(){this.open=true;};modal.close=function(){this.open=false;};
Object.defineProperty(window.HTMLElement.prototype,'elements',{get(){if(this.tagName!=='FORM')return undefined;return new Proxy({},{get:(_,k)=>this.querySelector(`[name="${String(k)}"]`)});}});
Object.defineProperty(window.HTMLInputElement.prototype,'checked',{get(){return this.hasAttribute('checked')},set(v){v?this.setAttribute('checked',''):this.removeAttribute('checked')}});
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(v){for(const o of this.querySelectorAll('option'))o.removeAttribute('selected');const option=Array.from(this.querySelectorAll('option')).find(o=>o.value===v);option?.setAttribute('selected','');}});
class FormDataShim{constructor(form){this.entries=[];for(const e of form.querySelectorAll('input,select,textarea')){if(!e.name||e.disabled||e.type==='file'||e.type==='checkbox'&&!e.checked)continue;this.entries.push([e.name,e.value]);}}get(n){return this.entries.find(x=>x[0]===n)?.[1]??null;}getAll(n){return this.entries.filter(x=>x[0]===n).map(x=>x[1]);}}
const listeners={};const context={window,document,console,localStorage:storage,location:{hash:'',protocol:'file:',search:''},navigator:{},FormData:FormDataShim,URL,URLSearchParams,Intl,Date,Math,JSON,Set,Map,Number,String,Object,Array,Error,structuredClone,crypto:require('node:crypto').webcrypto,setTimeout:()=>1,clearTimeout:()=>{},matchMedia:()=>({matches:false,addEventListener(){}})};
context.window={document,CASHEW_CONFIG:{},scrollTo(){},addEventListener(type,fn){listeners[type]=fn;}};
vm.createContext(context);vm.runInContext(fs.readFileSync(root+'/src/core.js','utf8'),context);context.window.CashewCore=context.CashewCore;
vm.runInContext(fs.readFileSync(root+'/src/app.js','utf8'),context);
const q=s=>{const e=document.querySelector(s);assert.ok(e,`Missing element: ${s}`);return e;};
const tick=()=>new Promise(r=>setImmediate(r));
async function click(s){q(s).dispatchEvent(new window.Event('click',{bubbles:true}));await tick();}
function fill(form,values){for(const [k,v]of Object.entries(values)){const el=q(form).elements[k];assert.ok(el,'Missing form element '+k);el.value=String(v);}}
async function submit(s){q(s).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();const e=document.querySelector('#form-error');assert.ok(!e?.textContent,`Form error: ${e?.textContent}`);}
const state=()=>JSON.parse(raw);
(async()=>{
 assert.ok(modal.open);await click('[data-action="start-demo"]');assert.ok(!modal.open);assert.equal(state().demo,true);
 for(const nav of ['transactions','budgets','recurring','analysis','goals','debts','accounts','categories','split','settings','home']){await click(`[data-nav="${nav}"]`);assert.ok(q('.main h1').textContent);assert.ok(!q('#app').innerHTML.includes('undefined'),'Undefined rendered on '+nav);}
 await click('[data-action="add-tx"]');fill('#tx-form',{title:'Smoke test coffee',amount:'12.34',date:'2026-10-12',account:'main',category:'food',notes:'<script>alert(1)</script>',tags:'smoke,test'});await submit('#tx-form');assert.equal(state().transactions.at(-1).amount,1234);assert.ok(!modal.open);
 let id=state().transactions.at(-1).id;await click('[data-nav="transactions"]');await click(`[data-tx="${id}"]`);assert.equal(modal.querySelectorAll('script').length,0);await click('[data-action="edit-tx"]');fill('#tx-form',{amount:'23.45'});await submit('#tx-form');assert.equal(state().transactions.at(-1).amount,2345);
 await click('[data-nav="accounts"]');await click('[data-action="add-account"]');fill('#account-form',{name:'QA Savings',opening:'123.45',currency:'CNY',icon:'bank'});await submit('#account-form');assert.equal(state().accounts.at(-1).opening,12345);
 const aId=state().accounts.at(-1).id;await click(`[data-action="transfer"][data-id="${aId}"]`);fill('#tx-form',{title:'QA Transfer',amount:'10.00',toAccount:'main'});await submit('#tx-form');assert.equal(state().transactions.at(-1).toAmount,1000);
 await click('[data-nav="categories"]');await click('[data-action="add-category"]');fill('#category-form',{name:'QA Category',color:'#abcdef'});await click('[data-pick-icon="coffee"]');await submit('#category-form');assert.equal(state().categories.at(-1).icon,'coffee');
 await click('[data-nav="budgets"]');await click('[data-action="add-budget"]');fill('#budget-form',{name:'QA Budget',amount:'1000',start:'2026-10-01',end:'2026-10-31','limit-food':'100'});await submit('#budget-form');assert.equal(state().budgets.at(-1).limits.food,10000);await click(`[data-budget="${state().budgets.at(-1).id}"]`);assert.match(modal.innerHTML,/QA Budget/);await click('[data-action="close"]');
 await click('[data-nav="goals"]');await click('[data-action="add-goal"]');fill('#goal-form',{name:'QA Goal',amount:'1000',initial:'200'});await submit('#goal-form');assert.equal(state().goals.at(-1).initial,20000);
 await click('[data-nav="recurring"]');await click('[data-action="add-recurring"]');fill('#recurring-form',{title:'QA Rent',amount:'88',next:'2026-10-31'});await submit('#recurring-form');const recurring=state().recurring.at(-1);await click(`[data-action="settle-recurring"][data-id="${recurring.id}"]`);await click('#confirm-action');assert.equal(state().recurring.at(-1).next,'2026-11-30');
 await click('[data-nav="debts"]');await click('[data-action="add-debt"]');fill('#debt-form',{name:'QA Friend',amount:'100'});await submit('#debt-form');const debt=state().debts.at(-1);await click(`[data-action="repay"][data-id="${debt.id}"]`);fill('#repay-form',{amount:'40'});await submit('#repay-form');assert.equal(state().transactions.at(-1).amount,4000);
 await click('[data-nav="split"]');fill('#split-form',{total:'100',people:'Alice\nBob\nCarol',payer:'Alice'});await submit('#split-form');assert.match(q('#split-result').textContent,/33.34/);assert.match(q('#split-result').textContent,/33.33/);
 await click('[data-nav="settings"]');fill('#settings-form',{name:'QA User',theme:'dark',language:'en'});await submit('#settings-form');assert.equal(state().settings.theme,'dark');assert.equal(document.documentElement.dataset.theme,'dark');assert.match(q('.main h1').textContent,/Settings/);
 await click('[data-action="customize"]');await click('[data-action="widget-down"]');await submit('#widgets-form');assert.notEqual(state().settings.widgets[0],'budgets');
 await click('[data-nav="transactions"]');q('#tx-search').value='Smoke test coffee';q('#tx-search').dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(q('#tx-results').querySelectorAll('[data-tx]').length,1);await click(`[data-tx="${id}"]`);await click('[data-action="delete-tx"]');await click('#confirm-action');assert.ok(!state().transactions.some(t=>t.id===id));
 console.log('PASS: all 11 pages; first-run demo, XSS escaping, transaction create/edit/delete, transfer, accounts, categories, budget/limits/detail, goals, recurring settlement, loans/repayment, splitter, settings, home customization and search. DOM simulation only; no browser/layout assertion.');
})().catch(e=>{console.error(e);console.error('Toast:',document.querySelector('#toast')?.textContent);process.exitCode=1;});
