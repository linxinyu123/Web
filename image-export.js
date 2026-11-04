const imageExport={sources:new Map(),file:null,pdf:null,task:null,renderTask:null,token:0,running:false,cancelled:false,folder:null};
function initImageExport(){
  const dialog=document.createElement('dialog');dialog.id='imageExportDialog';dialog.className='app-dialog export-dialog';dialog.setAttribute('aria-labelledby','imageExportTitle');
  dialog.innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">PDF TO IMAGES</span><h2 id="imageExportTitle">PDF 转图片</h2></div><button id="closeImageExport" aria-label="关闭 PDF 转图片">${icon('close')}</button></div><div class="export-scroll"><section class="preference-group"><div class="export-section-heading"><h3>选择文档</h3><button id="browseExportPdf" class="text-button">${icon('folder')}选择其他 PDF</button></div><select id="imageExportSource" aria-label="要转换的 PDF"></select><input id="exportPdfFile" type="file" accept="application/pdf,.pdf" hidden><p id="imageExportInfo" class="export-file-info">选择一份 PDF，开始逐页转换。</p></section><section class="preference-group"><h3>转换设置</h3><label class="export-field"><span>页码范围 <small>留空表示全部页面</small></span><input id="imageExportRange" type="text" inputmode="text" placeholder="例如 1-5, 8, 10-12" aria-label="转换页码范围"><small id="imageExportRangeHint">可使用逗号分隔页码与范围。</small></label><div class="export-settings-grid"><label class="export-field"><span>清晰度</span><select id="imageExportDpi" aria-label="图片清晰度"><option value="150">150 DPI · 标准</option><option value="300" selected>300 DPI · 高清</option><option value="450">450 DPI · 超清</option><option value="600">600 DPI · 印刷级</option></select></label><label class="export-field"><span>图片格式</span><select id="imageExportFormat" aria-label="图片格式"><option value="png">PNG · 无损</option><option value="jpeg">JPG · 高质量</option></select></label></div><label class="export-field"><span>文件名前缀</span><input id="imageExportPrefix" type="text" placeholder="自动使用 PDF 文件名" aria-label="导出文件名前缀"><small id="imageExportNamePreview">每张图片都会自动添加原文档页码。</small></label><p id="imageExportDimensions" class="export-dimensions"></p></section><section class="preference-group"><h3>保存位置</h3><div class="theme-options export-target-options"><button id="exportToFolder" aria-pressed="true">${icon('folder')}指定文件夹</button><button id="exportToZip" aria-pressed="false">${icon('download')}ZIP 下载</button></div><button id="chooseExportFolder" class="export-folder-picker">${icon('folder')}<span id="exportFolderName">选择保存文件夹</span>${icon('arrow')}</button><p id="imageExportTargetHint" class="export-target-hint">将自动创建以 PDF 命名的子文件夹；重名图片会保留现有文件。</p></section></div><div id="imageExportProgress" class="export-progress" hidden><div><strong id="imageExportProgressText">准备转换…</strong><span id="imageExportPercent">0%</span></div><div class="export-progress-track"><i id="imageExportProgressBar"></i></div></div><div class="export-footer"><p id="imageExportStatus" role="status" aria-live="polite">原始颜色导出 · 本地处理</p><button id="cancelImageExport" class="secondary-button" hidden>取消转换</button><button id="startImageExport" class="primary-button" disabled>开始转换</button></div>`;
  document.body.append(dialog);
  $('#closeImageExport').onclick=()=>{if(imageExport.running){imageExport.cancelled=true;imageExport.renderTask?.cancel();return;}dialog.close();};
  dialog.addEventListener('cancel',event=>{if(imageExport.running){event.preventDefault();imageExport.cancelled=true;imageExport.renderTask?.cancel();}});
  dialog.addEventListener('close',()=>{++imageExport.token;imageExport.task?.destroy();imageExport.task=null;imageExport.pdf=null;imageExport.file=null;});
  $('#browseExportPdf').onclick=()=>$('#exportPdfFile').click();
  $('#exportPdfFile').onchange=event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;const key=`external-${Date.now()}`;imageExport.sources.set(key,{file,name:file.name});const option=new Option(file.name,key);$('#imageExportSource').append(option);$('#imageExportSource').value=key;$('#imageExportSource')._customControl?.paint();loadImageExportSource(key);};
  $('#imageExportSource').onchange=()=>loadImageExportSource($('#imageExportSource').value);
  for(const id of ['imageExportRange','imageExportDpi','imageExportFormat','imageExportPrefix'])$(`#${id}`).addEventListener(id.includes('Range')||id.includes('Prefix')?'input':'change',updateImageExportDetails);
  $('#exportToFolder').onclick=()=>setImageExportTarget('folder');$('#exportToZip').onclick=()=>setImageExportTarget('zip');
  $('#chooseExportFolder').onclick=async()=>{try{imageExport.folder=await window.showDirectoryPicker({id:'pdf-image-export',mode:'readwrite',startIn:'downloads'});$('#exportFolderName').textContent=imageExport.folder.name;updateImageExportDetails();}catch(error){if(error.name!=='AbortError')$('#imageExportStatus').textContent='未获得文件夹写入权限，请重新选择保存目录。';}};
  $('#startImageExport').onclick=runImageExport;$('#cancelImageExport').onclick=()=>{imageExport.cancelled=true;imageExport.renderTask?.cancel();};
}
async function openImageExport(){
  if($('#imageExportDialog').open)return;
  imageExport.sources.clear();imageExport.pdf=null;imageExport.file=null;$('#imageExportRange').value='';$('#imageExportPrefix').value='';$('#imageExportProgress').hidden=true;$('#imageExportStatus').textContent='原始颜色导出 · 本地处理';$('#exportFolderName').textContent=imageExport.folder?.name||'选择 Downloads 或其他文件夹';
  const active=activeWorkspaceTab();
  for(const tab of [active,...workspace.tabs].filter(Boolean))for(const side of ['left','right']){const source=tab.sources[side];if(source?.file&&!imageExport.sources.has(source.docId))imageExport.sources.set(source.docId,{...source,name:source.file.name});}
  for(const record of await dbGetDocs().catch(()=>[]))if(record.blob&&!imageExport.sources.has(record.id))imageExport.sources.set(record.id,{record,name:record.name});
  const select=$('#imageExportSource');select.replaceChildren();for(const [id,source]of imageExport.sources)select.append(new Option(source.name,id));if(!select.options.length)select.append(new Option('先选择一份 PDF',''));
  select._customControl?.paint();setImageExportTarget(typeof window.showDirectoryPicker==='function'?'folder':'zip');$('#imageExportDialog').showModal();
  if(select.value)await loadImageExportSource(select.value);else updateImageExportDetails();
}
function setImageExportTarget(mode){
  const supports=typeof window.showDirectoryPicker==='function';imageExport.target=mode==='folder'&&supports?'folder':'zip';
  $('#exportToFolder').disabled=!supports;$('#exportToFolder').setAttribute('aria-pressed',String(imageExport.target==='folder'));$('#exportToZip').setAttribute('aria-pressed',String(imageExport.target==='zip'));$('#chooseExportFolder').hidden=imageExport.target!=='folder';
  $('#imageExportTargetHint').textContent=imageExport.target==='folder'?'选择 Downloads 后，图片会保存到 PDF 同名文件夹中；不会覆盖已有图片。':supports?'兼容下载方式。直接保存图片请选择“指定文件夹”。':'此浏览器不能直接写入本地文件夹，可使用 Chrome 或 Edge 选择 Downloads。';updateImageExportDetails();
}
async function loadImageExportSource(id){
  const source=imageExport.sources.get(id);if(!source)return;const token=++imageExport.token;imageExport.pdf=null;$('#startImageExport').disabled=true;$('#imageExportInfo').textContent='正在读取 PDF…';await imageExport.task?.destroy();
  try{
    const file=source.file||new File([source.record.blob],source.record.name,{type:'application/pdf'});imageExport.file=file;await getPdfEngine();if(token!==imageExport.token)return;
    const task=pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,cMapUrl:pdfAssetBase+'cmaps/',cMapPacked:true,standardFontDataUrl:pdfAssetBase+'standard_fonts/',wasmUrl:pdfAssetBase+'wasm/',iccUrl:pdfAssetBase+'iccs/'});imageExport.task=task;
    task.onPassword=async(update,reason)=>{const value=await requestPdfPassword(reason);if(value===null)task.destroy();else update(value);};
    const pdf=await task.promise;if(token!==imageExport.token){await task.destroy();return;}imageExport.pdf=pdf;$('#imageExportInfo').textContent=`${file.name} · ${pdf.numPages} 页 · ${formatBytes(file.size)}`;$('#imageExportPrefix').value=imageFilePrefix(file.name);$('#imageExportRangeHint').textContent=`共 ${pdf.numPages} 页，可输入 1-${pdf.numPages} 或多个不连续范围。`;updateImageExportDetails();
  }catch(error){if(token!==imageExport.token)return;$('#imageExportInfo').textContent='无法读取此 PDF，请重新选择。';$('#imageExportStatus').textContent=error.message||'文档加载失败';}
}
async function updateImageExportDetails(){
  const pdf=imageExport.pdf,button=$('#startImageExport');button.disabled=!pdf||imageExport.running||(imageExport.target==='folder'&&!imageExport.folder);
  if(pdf&&!imageExport.running&&imageExport.target==='folder'&&!imageExport.folder)$('#imageExportStatus').textContent='请先选择 Downloads 或其他保存目录。';
  const prefix=imageFilePrefix($('#imageExportPrefix').value||imageExport.file?.name),extension=$('#imageExportFormat').value==='png'?'png':'jpg';$('#imageExportNamePreview').textContent=`文件名示例：${prefix}_page-0001.${extension}`;
  if(!pdf){$('#imageExportDimensions').textContent='';return;}
  try{const pages=parsePdfPageRange($('#imageExportRange').value,pdf.numPages);button.textContent=`转换 ${pages.length} 页`;const page=await pdf.getPage(pages[0]);if(imageExport.pdf!==pdf)return;const viewport=page.getViewport({scale:Number($('#imageExportDpi').value)/72});$('#imageExportDimensions').textContent=`首张约 ${Math.ceil(viewport.width-1e-6)} × ${Math.ceil(viewport.height-1e-6)} 像素 · ${$('#imageExportDpi').value} DPI`;$('#imageExportRange').setAttribute('aria-invalid','false');}catch(error){button.disabled=true;$('#imageExportDimensions').textContent=error.message;$('#imageExportRange').setAttribute('aria-invalid','true');}
}
function setImageExportBusy(busy){
  imageExport.running=busy;$('#cancelImageExport').hidden=!busy;$('#startImageExport').hidden=busy;$('#closeImageExport').setAttribute('aria-label',busy?'取消转换':'关闭 PDF 转图片');
  for(const element of $('#imageExportDialog').querySelectorAll('.export-scroll input,.export-scroll select,.export-scroll button'))element.disabled=busy;
  if(!busy){$('#exportToFolder').disabled=typeof window.showDirectoryPicker!=='function';updateImageExportDetails();}
}
async function writeExportImage(directory,name,blob){
  const dot=name.lastIndexOf('.'),base=name.slice(0,dot),extension=name.slice(dot);let candidate=name,index=1;
  for(;;){try{await directory.getFileHandle(candidate);candidate=`${base}-${++index}${extension}`;}catch(error){if(error.name==='NotFoundError')break;throw error;}}
  const handle=await directory.getFileHandle(candidate,{create:true}),stream=await handle.createWritable();try{await stream.write(blob);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
}
async function runImageExport(){
  const pdf=imageExport.pdf;if(!pdf||imageExport.running)return;let pages;try{pages=parsePdfPageRange($('#imageExportRange').value,pdf.numPages);}catch(error){$('#imageExportStatus').textContent=error.message;return;}
  const dpi=Number($('#imageExportDpi').value),format=$('#imageExportFormat').value,prefix=imageFilePrefix($('#imageExportPrefix').value||imageExport.file.name),extension=format==='png'?'png':'jpg';
  const records=[];let bytes=0,completed=0,directory=null,canvas;
  imageExport.cancelled=false;setImageExportBusy(true);$('#imageExportProgress').hidden=false;$('#imageExportProgressBar').style.width='0%';$('#imageExportPercent').textContent='0%';
  try{
    if(imageExport.target==='folder'){if(!imageExport.folder)throw new Error('请先选择保存文件夹。');directory=await imageExport.folder.getDirectoryHandle(imageFilePrefix(imageExport.file.name),{create:true});}
    const limit=matchMedia('(pointer: coarse)').matches?16_000_000:48_000_000;
    for(const number of pages){
      if(imageExport.cancelled)break;$('#imageExportProgressText').textContent=`正在转换第 ${number} 页 · ${completed+1} / ${pages.length}`;
      const page=await pdf.getPage(number),viewport=page.getViewport({scale:dpi/72}),width=Math.ceil(viewport.width-1e-6),height=Math.ceil(viewport.height-1e-6);
      if(width*height>limit||width>16384||height>16384)throw new Error(`第 ${number} 页在此清晰度下尺寸过大，请降低 DPI 后重试。`);
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      imageExport.renderTask=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)',intent:'print'});await imageExport.renderTask.promise;imageExport.renderTask=null;
      if(imageExport.cancelled)break;
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图片编码失败，请降低清晰度重试。')),format==='png'?'image/png':'image/jpeg',.98));
      const name=`${prefix}_page-${String(number).padStart(Math.max(4,String(pdf.numPages).length),'0')}.${extension}`;
      if(directory)await writeExportImage(directory,name,blob);else{bytes+=blob.size;if(bytes>512*1024*1024)throw new Error('图片总量较大，请缩小页码范围，或改为保存到文件夹。');records.push({name,blob});}
      canvas.width=canvas.height=1;canvas=null;page.cleanup();completed++;const percent=Math.round(completed/pages.length*100);$('#imageExportProgressBar').style.width=`${percent}%`;$('#imageExportPercent').textContent=`${percent}%`;$('#imageExportStatus').textContent=`已转换 ${completed} / ${pages.length} 页`;await nextFrame();
    }
    if(imageExport.cancelled){$('#imageExportStatus').textContent=directory?`已取消，已保存 ${completed} 页，其余页面未导出。`:'已取消，未生成压缩包。';return;}
    if(!directory){$('#imageExportProgressText').textContent='正在打包图片…';const zip=await buildImageZip(records);if(imageExport.cancelled){$('#imageExportStatus').textContent='已取消，未下载压缩包。';return;}const url=URL.createObjectURL(zip),link=document.createElement('a');link.href=url;link.download=`${prefix}_pages.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    $('#imageExportProgressText').textContent='转换完成';$('#imageExportStatus').textContent=directory?`已保存 ${completed} 张图片到 ${directory.name}`:`已生成 ${completed} 张图片的 ZIP 下载`;
  }catch(error){$('#imageExportStatus').textContent=imageExport.cancelled?(directory?`已取消，已保存 ${completed} 页。`:'已取消，未生成压缩包。'):`${error.message||'转换失败'}${completed&&directory?` 已保存 ${completed} 页。`:''}`;}
  finally{if(canvas)canvas.width=canvas.height=1;imageExport.renderTask=null;records.length=0;setImageExportBusy(false);}
}
