import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import worker from '../worker/index.mjs';import Core from '../src/core.js';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../worker/migrations/0001_initial.sql',import.meta.url),'utf8'));
 const objects=new Map();
 return {
  API_TOKEN:'unit-test-token-that-has-at-least-32-characters',
  ALLOWED_ORIGINS:'https://example.github.io',
  DB:{prepare(sql){const stmt=db.prepare(sql);return {bind(...args){return {
   async first(){return stmt.get(...args)||null;},
   async run(){return {meta:{changes:stmt.run(...args).changes}};}
  };}};}},
  BUCKET:{async put(key,value,options){objects.set(key,{value,options});},
   async get(key){const x=objects.get(key);if(!x)return null;return {text:async()=>x.value,body:x.value,httpMetadata:x.options?.httpMetadata};},
   async delete(key){objects.delete(key);}},objects,db
 };
}
function req(env,path,method='GET',body,extra={}){return new Request('https://api.example.com'+path,{method,headers:{Authorization:'Bearer '+env.API_TOKEN,Origin:'https://example.github.io',...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
test('unauthorized or unconfigured requests fail closed; CORS exact match',async()=>{const env=setup();let r=await worker.fetch(req(env,'/v1/snapshot','GET',null,{Authorization:'Bearer wrong'}),env);assert.equal(r.status,401);r=await worker.fetch(req(env,'/v1/snapshot','GET',null,{Origin:'https://evil.example'}),env);assert.equal(r.status,403);r=await worker.fetch(req(env,'/v1/snapshot','GET'),{...env,API_TOKEN:''});assert.equal(r.status,503);r=await worker.fetch(req(env,'/v1/snapshot','OPTIONS'),env);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://example.github.io');});
test('snapshot upload/download roundtrip, CAS conflict and no stale overwrite',async()=>{const env=setup();let r=await worker.fetch(req(env,'/v1/snapshot'),env);assert.deepEqual(await r.json(),{version:0,data:null});const d=Core.defaults();r=await worker.fetch(req(env,'/v1/snapshot','PUT',{expectedVersion:0,data:d}),env);assert.equal(r.status,200);assert.equal((await r.json()).version,1);const stale=await worker.fetch(req(env,'/v1/snapshot','PUT',{expectedVersion:0,data:d}),env);assert.equal(stale.status,409);assert.equal(env.objects.size,1);const updated=structuredClone(d);updated.settings.name='Updated';r=await worker.fetch(req(env,'/v1/snapshot','PUT',{expectedVersion:1,data:updated}),env);assert.equal(r.status,200);r=await worker.fetch(req(env,'/v1/snapshot'),env);const result=await r.json();assert.equal(result.version,2);assert.equal(result.data.settings.name,'Updated');});
test('two writes with same expected version cannot both succeed',async()=>{const env=setup();const requests=[0,1].map(()=>worker.fetch(req(env,'/v1/snapshot','PUT',{expectedVersion:0,data:Core.defaults()}),env));const results=await Promise.all(requests);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(env.objects.size,1);});
test('invalid snapshots and oversized bodies rejected before storage',async()=>{const env=setup();for(const [body,status]of [[{data:{}},400],[{data:{},expectedVersion:0},400],['{broken',400]]){const r=await worker.fetch(req(env,'/v1/snapshot','PUT',body),env);assert.equal(r.status,status);}const r=await worker.fetch(req(env,'/v1/snapshot','PUT','x'.repeat(8*1024*1024+1)),env);assert.equal(r.status,413);assert.equal(env.objects.size,0);});
test('private R2 image upload, retrieval and deletion',async()=>{const env=setup(),bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);const request=new Request('https://api.example.com/v1/attachments',{method:'POST',headers:{Authorization:'Bearer '+env.API_TOKEN,'Content-Type':'image/png'},body:bytes});let r=await worker.fetch(request,env);assert.equal(r.status,201);const {key}=await r.json();r=await worker.fetch(req(env,'/v1/attachments/'+key),env);assert.equal(r.status,200);assert.equal(r.headers.get('Content-Type'),'image/png');assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);r=await worker.fetch(req(env,'/v1/attachments/'+key,'DELETE'),env);assert.equal(r.status,204);r=await worker.fetch(req(env,'/v1/attachments/'+key),env);assert.equal(r.status,404);});
