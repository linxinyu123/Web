import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>readFile(path.join(root,f),'utf8');
const awaitLicense=(await read('LICENSE'))+'\n'+(await read('THIRD_PARTY_NOTICES.md'))+'\n'+(await read('assets/OFL-DMSans.txt'));
let html=await read('index.html'),css=await read('styles.css'),app=await read('src/app.js');
for(const name of ['DMSans-Regular.ttf','DMSans-Bold.ttf']){const b=await readFile(path.join(root,'assets',name));css=css.replaceAll(`assets/${name}`,`data:font/ttf;base64,${b.toString('base64')}`);}
const logo='data:image/png;base64,'+(await readFile(path.join(root,'assets/icon.png'))).toString('base64');
html=html.replace('<link rel="manifest" href="manifest.webmanifest">','').replace('<link rel="stylesheet" href="styles.css">','<style>'+css+'</style>').replace('href="assets/icon.png"',`href="${logo}"`);
app=app.replaceAll('src="assets/icon.png"',`src="${logo}"`);
for(const [source,content]of [['config.js',await read('config.js')],['src/core.js',await read('src/core.js')],['src/app.js',app]])html=html.replace(`<script src="${source}"></script>`,()=>`<script>${source==='config.js'?'window.CASHEW_SINGLE_FILE=true;':''}\n${content.replaceAll('</script','<\\/script')}\n</script>`);
html=html.replace('<!doctype html>',()=> '<!doctype html>\n<!--\n'+(awaitLicense)+'\n-->');
await writeFile(path.join(root,'Cashew.html'),html);
const dist=path.join(root,'dist');await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
for(const file of ['index.html','styles.css','config.js','src','assets','sw.js','manifest.webmanifest','LICENSE','THIRD_PARTY_NOTICES.md','README.md','FEATURES.md','API.md'])await cp(path.join(root,file),path.join(dist,file),{recursive:true});
await writeFile(path.join(dist,'.nojekyll'),'');
console.log('Created Cashew.html (self-contained) and dist/ (GitHub Pages).');
