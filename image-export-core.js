function parsePdfPageRange(value,total){
  if(!Number.isInteger(total)||total<1)throw new Error('请先选择有效的 PDF。');
  const text=String(value||'').trim();
  if(!text||/^(全部|所有|all)$/i.test(text))return Array.from({length:total},(_,i)=>i+1);
  const pages=new Set();
  for(const token of text.replace(/\s*[-–—~～]\s*/g,'-').split(/[,，、;；\s]+/).filter(Boolean)){
    const match=/^(\d+)(?:-(\d+))?$/.exec(token);if(!match)throw new Error(`页码格式不正确：${token}。例如 1-5, 8, 10-12。`);
    const start=Number(match[1]),end=Number(match[2]||match[1]);
    if(start<1||end>total||start>end)throw new Error(`页码范围应在 1–${total} 页之间，起始页不能大于结束页。`);
    for(let n=start;n<=end;n++)pages.add(n);
  }
  if(!pages.size)throw new Error('请输入要转换的页码。');
  return [...pages].sort((a,b)=>a-b);
}
function imageFilePrefix(value){
  let name=String(value||'PDF').replace(/\.pdf$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').trim().slice(0,100)||'PDF';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
  return name;
}
let imageZipCrcTable;
function imageZipCrc(bytes){
  if(!imageZipCrcTable){imageZipCrcTable=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;imageZipCrcTable[n]=c>>>0;}}
  let crc=0xFFFFFFFF;for(const byte of bytes)crc=imageZipCrcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xFFFFFFFF)>>>0;
}
async function buildImageZip(records){
  const encoder=new TextEncoder(),parts=[],central=[];let offset=0,centralSize=0;
  for(const record of records){
    const name=encoder.encode(record.name),bytes=new Uint8Array(await record.blob.arrayBuffer()),crc=imageZipCrc(bytes),size=record.blob.size;
    const local=new Uint8Array(30+name.length),view=new DataView(local.buffer);view.setUint32(0,0x04034B50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);view.setUint16(26,name.length,true);local.set(name,30);parts.push(local,record.blob);
    const entry=new Uint8Array(46+name.length),cv=new DataView(entry.buffer);cv.setUint32(0,0x02014B50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);entry.set(name,46);central.push(entry);centralSize+=entry.length;offset+=local.length+size;
  }
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054B50,true);ev.setUint16(8,records.length,true);ev.setUint16(10,records.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
