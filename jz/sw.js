/* Cashew caches its application shell only. Ledger data remains in local storage. */
const CACHE='cashew-shell-v5-20261013';
const ROOT=new URL('./',self.location.href).href;
const APP=new URL('index.html',ROOT).href;
const ASSETS=['index.html','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/maskable-512.png','icons/apple-touch-icon.png'].map(x=>new URL(x,ROOT).href);
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
 // Activate normally after old tabs close. Never interrupt an unsaved entry by forcing a reload.
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('cashew-shell-')&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||!url.href.startsWith(ROOT))return;
 if(request.mode==='navigate'){
  // Restrict offline navigation fallback to the app entry points, not unrelated pages.
  const entry=url.pathname===new URL(ROOT).pathname||url.pathname===new URL(APP).pathname;
  if(!entry)return;
  const network=fetch(request).then(async response=>{
   if(response.ok&&response.headers.get('content-type')?.includes('text/html')){const cache=await caches.open(CACHE);await cache.put(APP,response.clone());}
   return response;
  });
  event.waitUntil(network.then(()=>{},()=>{}));
  event.respondWith((async()=>{
   let timer;
   try{return await Promise.race([network,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('offline timeout')),3500);})]);}
   catch{const cache=await caches.open(CACHE),saved=await cache.match(APP);if(saved)return saved;return new Response('首次使用请连接网络。',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
   finally{clearTimeout(timer);}
  })());return;
 }
 if(!ASSETS.includes(url.href))return;
 event.respondWith((async()=>{const cache=await caches.open(CACHE),saved=await cache.match(request);if(saved)return saved;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;})());
});
