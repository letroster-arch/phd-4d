import { base44 } from '@/api/base44Client';
import * as THREE from 'three';
import { createThreeGeometry, finiteBox, matrixFromBundleTransform } from '@/components/twin/sgeoNative';
import { readHyperViewPackedChunk } from '@/components/twin/hyperViewRenderCache';

const FORMAT_VERSION='phd3d-spatial-v3.1';
const MAX_RAW_BYTES=16*1024*1024;
const MAX_OBJECTS_PER_FILE=1024;
const SPATIAL_OBJECTS_PER_CHUNK=256;
const PREVIEW_OBJECTS=192;
const UPLOAD_CONCURRENCY=4;
const UPLOAD_RETRY_DELAYS=[0,1500,3500,7000];
const MAGIC=new Uint8Array([80,72,68,51,68,51,0,0]); // PHD3D3
const PREFIX_BYTES=12;
const LOCAL_CACHE_DIR='phd3d-local-v1';
const FAST_CACHE_VERSION='phd3d-fast-v1';
const COLOR_CACHE_VERSION=5;
const FAST_PACK_CHUNKS=48;
const localChunkLoadInflight=new Map();
const fastIndexMemory=new Map();
const fastPackMemory=new Map();
const fastBuildInflight=new Map();
let localPersistenceRequested=false;

function align4(value){return (Number(value)+3)&~3}

function wait(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function hashString(value){
  let hash=2166136261;
  const text=String(value||'');
  for(let i=0;i<text.length;i++){
    hash^=text.charCodeAt(i);
    hash=Math.imul(hash,16777619);
  }
  return (hash>>>0).toString(16).padStart(8,'0');
}

function localChunkBaseName(descriptor){
  const identity=[
    descriptor?.cacheKey||descriptor?.versionId||'',
    descriptor?.format||FORMAT_VERSION,
    descriptor?.chunkIndex||0,
    descriptor?.packedBytes||0,
    descriptor?.fileUri||''
  ].join('|');
  return hashString(identity);
}

function localChunkFileName(descriptor){
  return localChunkBaseName(descriptor)+'.phd3dpack';
}

function localChunkColorFileName(descriptor){
  return localChunkBaseName(descriptor)+'.colors.json';
}

function localIndexFileName(cacheKeyValue){
  return 'index-'+hashString(String(cacheKeyValue||'')+'|'+FORMAT_VERSION)+'.json';
}

function fastIndexFileName(cacheKeyValue){
  return 'fast-index-'+hashString(String(cacheKeyValue||'')+'|'+FORMAT_VERSION+'|'+FAST_CACHE_VERSION)+'.json';
}

function fastPackFileName(cacheKeyValue,packIndex){
  return 'fast-pack-'+hashString(String(cacheKeyValue||'')+'|'+FORMAT_VERSION)+'-'+String(packIndex).padStart(3,'0')+'.bin';
}

function fastDescriptorFingerprint(chunks){
  const source=chunks||[];
  const totalBytes=source.reduce((sum,item)=>sum+Number(item?.packedBytes||0),0);
  return [FORMAT_VERSION,FAST_CACHE_VERSION,source.length,totalBytes].join('|');
}

function manifestFingerprint(manifest){
  return [
    manifest?.id||'',
    manifest?.format_version||FORMAT_VERSION,
    manifest?.cached_chunks||0,
    manifest?.total_bytes||0,
    manifest?.completed_at||''
  ].join('|');
}

function opfsSupported(){
  return typeof navigator!=='undefined'&&!!navigator.storage?.getDirectory;
}

async function requestPersistentStorage(){
  if(localPersistenceRequested||typeof navigator==='undefined')return;
  localPersistenceRequested=true;
  try{await navigator.storage?.persist?.()}catch{}
}

async function localCacheDirectory(){
  if(!opfsSupported())return null;
  await requestPersistentStorage();
  const root=await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LOCAL_CACHE_DIR,{create:true});
}

async function readLocalPackedChunk(descriptor){
  const directory=await localCacheDirectory();
  if(!directory)return null;
  const name=localChunkFileName(descriptor);
  try{
    const handle=await directory.getFileHandle(name);
    const file=await handle.getFile();
    const expected=Number(descriptor?.packedBytes||0);
    if(expected>0&&file.size!==expected){
      try{await directory.removeEntry(name)}catch{}
      return null;
    }
    const bytes=new Uint8Array(await file.arrayBuffer());
    return bytes.byteLength?bytes:null;
  }catch(error){
    if(error?.name==='NotFoundError')return null;
    return null;
  }
}

async function writeLocalPackedChunk(descriptor,bytes){
  const directory=await localCacheDirectory();
  if(!directory||!bytes?.byteLength)return false;
  const name=localChunkFileName(descriptor);
  try{
    const handle=await directory.getFileHandle(name,{create:true});
    const writable=await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return true;
  }catch{
    return false;
  }
}

async function deleteLocalPackedChunk(descriptor){
  const directory=await localCacheDirectory();
  if(!directory)return;
  try{await directory.removeEntry(localChunkFileName(descriptor))}catch{}
}

async function readLocalChunkColors(descriptor){
  const directory=await localCacheDirectory();
  if(!directory)return null;
  try{
    const handle=await directory.getFileHandle(localChunkColorFileName(descriptor));
    const file=await handle.getFile();
    const parsed=JSON.parse(await file.text());
    if(!parsed||typeof parsed!=='object')return null;
    if(parsed.__phdColorCache===COLOR_CACHE_VERSION){
      return {colors:parsed.colors||{},complete:parsed.complete!==false};
    }
    if(parsed.__phdColorCache){
      // Sidecars de versões anteriores podem conter cores válidas, porém
      // precisam ser re-hidratados pelo resolver atual antes de serem marcados
      // como completos. Isso corrige caches antigos salvos sem a aparência
      // original do Navisworks/Speckle.
      return {colors:parsed.colors||{},complete:false};
    }
    // Compatibilidade com o formato legado, que era somente o mapa de cores.
    return {colors:parsed,complete:false};
  }catch{
    return null;
  }
}

async function applyLocalChunkColors(descriptor,objects){
  const local=await readLocalChunkColors(descriptor);
  if(!local){descriptor.__localColorsComplete=false;return 0}
  descriptor.__localColorsComplete=!!local.complete;
  const colors=local.colors||{};
  let applied=0;
  for(const object of objects||[]){
    if(object.displayColor)continue;
    const color=colors[String(object.objectIndex)];
    if(color){object.displayColor=String(color);applied++}
  }
  return applied;
}

export async function persistPHDLocalChunkColors(descriptor,objects){
  const colors={};
  for(const object of objects||[]){
    if(object?.displayColor)colors[String(object.objectIndex)]=String(object.displayColor);
  }
  const directory=await localCacheDirectory();
  if(!directory)return false;
  try{
    const handle=await directory.getFileHandle(localChunkColorFileName(descriptor),{create:true});
    const writable=await handle.createWritable();
    await writable.write(JSON.stringify({__phdColorCache:COLOR_CACHE_VERSION,complete:true,colors}));
    await writable.close();
    descriptor.__localColorsComplete=true;
    return true;
  }catch{
    return false;
  }
}

async function readLocalDescriptorIndex(manifest){
  const directory=await localCacheDirectory();
  if(!directory)return null;
  try{
    const handle=await directory.getFileHandle(localIndexFileName(manifest?.cache_key));
    const file=await handle.getFile();
    const parsed=JSON.parse(await file.text());
    if(parsed?.fingerprint!==manifestFingerprint(manifest)||!Array.isArray(parsed?.chunks))return null;
    return parsed.chunks;
  }catch{
    return null;
  }
}

async function invalidateLocalDescriptorIndex(cacheKeyValue){
  const directory=await localCacheDirectory();
  if(!directory)return;
  try{await directory.removeEntry(localIndexFileName(cacheKeyValue))}catch{}
}

async function writeLocalDescriptorIndex(manifest,chunks){
  const directory=await localCacheDirectory();
  if(!directory||!manifest?.cache_key||!Array.isArray(chunks)||!chunks.length)return false;
  try{
    const handle=await directory.getFileHandle(localIndexFileName(manifest.cache_key),{create:true});
    const writable=await handle.createWritable();
    await writable.write(JSON.stringify({
      fingerprint:manifestFingerprint(manifest),
      chunks
    }));
    await writable.close();
    return true;
  }catch{
    return false;
  }
}

async function readPHDLocalFastIndex(cacheKeyValue,chunks=null){
  const key=String(cacheKeyValue||'');
  if(!key)return null;
  if(fastIndexMemory.has(key)){
    const cached=fastIndexMemory.get(key);
    if(!chunks||cached?.fingerprint===fastDescriptorFingerprint(chunks))return cached;
    fastIndexMemory.delete(key);
  }

  const directory=await localCacheDirectory();
  if(!directory)return null;
  try{
    const handle=await directory.getFileHandle(fastIndexFileName(key));
    const file=await handle.getFile();
    const parsed=JSON.parse(await file.text());
    if(
      parsed?.version!==FAST_CACHE_VERSION||
      parsed?.format!==FORMAT_VERSION||
      !parsed?.chunks||
      !parsed?.packs
    )return null;
    if(chunks&&parsed.fingerprint!==fastDescriptorFingerprint(chunks))return null;
    fastIndexMemory.set(key,parsed);
    return parsed;
  }catch{
    return null;
  }
}

async function writePHDLocalFastIndex(cacheKeyValue,index){
  const key=String(cacheKeyValue||'');
  const directory=await localCacheDirectory();
  if(!directory||!key||!index)return false;
  try{
    const handle=await directory.getFileHandle(fastIndexFileName(key),{create:true});
    const writable=await handle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
    fastIndexMemory.set(key,index);
    return true;
  }catch{
    return false;
  }
}

async function readFastPackedChunk(descriptor){
  const key=String(descriptor?.cacheKey||'');
  if(!key)return null;
  const index=await readPHDLocalFastIndex(key);
  const ref=index?.chunks?.[String(descriptor?.chunkIndex)];
  if(!ref)return null;
  if(Number(descriptor?.packedBytes||0)>0&&Number(ref.length)!==Number(descriptor.packedBytes))return null;

  const memoryKey=key+'|'+String(ref.pack);
  let packPromise=fastPackMemory.get(memoryKey);
  if(!packPromise){
    packPromise=(async()=>{
      const directory=await localCacheDirectory();
      if(!directory)throw new Error('OPFS indisponível para Fast Cache.');
      const handle=await directory.getFileHandle(String(ref.pack));
      const file=await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    })();
    fastPackMemory.set(memoryKey,packPromise);

    // Evita manter centenas de MB duplicados na RAM. O carregamento Fast usa
    // ordem por pack, então dois packs em memória são suficientes.
    while(fastPackMemory.size>2){
      const oldest=fastPackMemory.keys().next().value;
      if(oldest===memoryKey)break;
      fastPackMemory.delete(oldest);
    }
  }

  try{
    const bytes=await packPromise;
    const start=Number(ref.offset||0);
    const end=start+Number(ref.length||0);
    if(start<0||end>bytes.byteLength||end<=start)return null;
    return bytes.subarray(start,end);
  }catch{
    fastPackMemory.delete(memoryKey);
    return null;
  }
}

export async function getPHDLocalFastCacheStatus(cacheKeyValue,chunks=[]){
  const index=await readPHDLocalFastIndex(cacheKeyValue,chunks);
  return {
    ready:!!index,
    version:index?.version||null,
    packs:Number(index?.packs?.length||0),
    chunks:Number(Object.keys(index?.chunks||{}).length)
  };
}

export async function buildPHDLocalFastCache(cache,chunks,{onProgress}={}){
  const cacheKeyValue=String(cache?.cache_key||chunks?.[0]?.cacheKey||'');
  const source=[...(chunks||[])].sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));
  if(!cacheKeyValue||!source.length||!opfsSupported())return {ready:false,reason:'unsupported'};

  const existing=await readPHDLocalFastIndex(cacheKeyValue,source);
  if(existing)return {
    ready:true,
    reused:true,
    packs:Number(existing.packs?.length||0),
    chunks:source.length
  };

  if(fastBuildInflight.has(cacheKeyValue))return fastBuildInflight.get(cacheKeyValue);

  const promise=(async()=>{
    const directory=await localCacheDirectory();
    if(!directory)return {ready:false,reason:'opfs'};

    const chunkMap={};
    const packs=[];
    let processed=0;

    for(let packIndex=0,offset=0;offset<source.length;packIndex++,offset+=FAST_PACK_CHUNKS){
      const group=source.slice(offset,offset+FAST_PACK_CHUNKS);
      const packName=fastPackFileName(cacheKeyValue,packIndex);
      const handle=await directory.getFileHandle(packName,{create:true});
      const writable=await handle.createWritable();
      let position=0;
      let packValid=true;

      try{
        for(const descriptor of group){
          const bytes=await readLocalPackedChunk(descriptor);
          if(!bytes?.byteLength){
            packValid=false;
            break;
          }

          await writable.write(bytes);
          chunkMap[String(descriptor.chunkIndex)]={
            pack:packName,
            offset:position,
            length:bytes.byteLength
          };
          position+=bytes.byteLength;
          processed++;
          onProgress?.({
            processed,
            total:source.length,
            progress:Math.round((processed/source.length)*100),
            pack:packIndex+1
          });

          if(processed%24===0)await wait(0);
        }
      }finally{
        await writable.close();
      }

      if(!packValid){
        try{await directory.removeEntry(packName)}catch{}
        return {ready:false,reason:'missing-local-chunk',processed};
      }

      packs.push({name:packName,size:position,chunks:group.length});
    }

    const index={
      version:FAST_CACHE_VERSION,
      format:FORMAT_VERSION,
      cacheKey:cacheKeyValue,
      fingerprint:fastDescriptorFingerprint(source),
      createdAt:new Date().toISOString(),
      packs,
      chunks:chunkMap
    };

    const saved=await writePHDLocalFastIndex(cacheKeyValue,index);
    if(!saved)return {ready:false,reason:'index-write'};
    return {ready:true,reused:false,packs:packs.length,chunks:source.length};
  })().finally(()=>fastBuildInflight.delete(cacheKeyValue));

  fastBuildInflight.set(cacheKeyValue,promise);
  return promise;
}

export async function hydratePHDLocalCacheFromRenderPacks(chunks,{concurrency=12,onProgress}={}){
  const source=[...(chunks||[])]
    .filter(item=>item?.renderPackUri&&Number(item?.renderPackLength||0)>0)
    .sort((a,b)=>
      Number(a.renderPackIndex??9999)-Number(b.renderPackIndex??9999)||
      Number(a.renderPackOffset||0)-Number(b.renderPackOffset||0)
    );
  if(!source.length||!opfsSupported())return {ready:false,reason:'no-render-packs',processed:0,total:source.length};

  await requestPersistentStorage();

  let cursor=0,processed=0,existing=0,written=0,failed=0;
  const workers=Math.max(1,Math.min(Number(concurrency)||1,source.length));

  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=source.length)return;
      const descriptor=source[index];
      try{
        const local=await readLocalPackedChunk(descriptor);
        if(local?.byteLength){
          existing++;
        }else{
          const packed=await readHyperViewPackedChunk(descriptor);
          if(!packed?.byteLength)throw new Error('Render pack sem dados para o chunk.');
          const expected=Number(descriptor?.packedBytes||0);
          if(expected>0&&packed.byteLength!==expected){
            throw new Error('Tamanho do chunk divergente no Render Cache.');
          }
          const saved=await writeLocalPackedChunk(descriptor,packed);
          if(!saved)throw new Error('Falha ao persistir chunk no OPFS.');
          written++;
        }
      }catch{
        failed++;
      }finally{
        processed++;
        onProgress?.({
          processed,
          total:source.length,
          existing,
          written,
          failed,
          progress:Math.round((processed/Math.max(1,source.length))*100)
        });
      }
      if(processed%24===0)await wait(0);
    }
  };

  await Promise.all(Array.from({length:workers},()=>worker()));
  return {
    ready:failed===0,
    processed,
    total:source.length,
    existing,
    written,
    failed
  };
}

export async function ensurePHDLocalCachePersistence(){
  if(typeof navigator==='undefined'||!navigator.storage)return {supported:false,persisted:false};
  let persisted=false;
  try{
    persisted=!!(await navigator.storage.persisted?.());
    if(!persisted&&navigator.storage.persist){
      persisted=!!(await navigator.storage.persist());
    }
  }catch{}
  return {supported:opfsSupported(),persisted};
}

export async function getPHDLocalCacheStatus(){
  if(typeof navigator==='undefined')return {supported:false,persisted:false,usage:0,quota:0};
  let persisted=false,usage=0,quota=0;
  try{persisted=!!(await navigator.storage?.persisted?.())}catch{}
  try{
    const estimate=await navigator.storage?.estimate?.();
    usage=Number(estimate?.usage||0);
    quota=Number(estimate?.quota||0);
  }catch{}
  return {supported:opfsSupported(),persisted,usage,quota};
}

async function mapConcurrent(items,concurrency,mapper){
  const source=[...(items||[])];
  if(!source.length)return [];
  const result=new Array(source.length);
  let cursor=0;
  const workers=Math.max(1,Math.min(Number(concurrency)||1,source.length));
  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=source.length)return;
      result[index]=await mapper(source[index],index);
    }
  };
  await Promise.all(Array.from({length:workers},()=>worker()));
  return result;
}

async function updateManifestRecord(id,payload){
  let lastError=null;
  for(const delay of [0,1000,3000]){
    if(delay)await wait(delay);
    try{return await base44.entities.GeometryCacheManifest.update(id,payload)}
    catch(error){lastError=error}
  }
  throw lastError||new Error('Falha ao salvar checkpoint do cache PHD3D.');
}

function parseManifestChunks(manifest){
  try{
    const parsed=JSON.parse(manifest?.chunks_json||'[]');
    return Array.isArray(parsed)?parsed:[];
  }catch{
    return [];
  }
}

function descriptorToChunkRecord(manifest,descriptor){
  return {
    cache_key:String(manifest.cache_key||''),
    manifest_id:String(manifest.id||''),
    project_id:String(manifest.project_id||''),
    model_id:String(manifest.model_id||''),
    version_id:String(manifest.version_id||''),
    format_version:String(descriptor.format||manifest.format_version||FORMAT_VERSION),
    chunk_index:Number(descriptor.chunkIndex||0),
    file_uri:String(descriptor.fileUri||''),
    compression:String(descriptor.compression||'none'),
    role:String(descriptor.role||'detail'),
    lod:Number(descriptor.lod??2),
    object_count:Number(descriptor.objectCount||0),
    instance_count:Number(descriptor.instanceCount||0),
    unique_geometry_count:Number(descriptor.uniqueGeometryCount||0),
    object_index_min:Number.isFinite(Number(descriptor.objectIndexMin))?Number(descriptor.objectIndexMin):null,
    object_index_max:Number.isFinite(Number(descriptor.objectIndexMax))?Number(descriptor.objectIndexMax):null,
    bounds_json:JSON.stringify(descriptor.bounds||null),
    center_json:JSON.stringify(descriptor.center||null),
    raw_bytes:Number(descriptor.rawBytes||0),
    packed_bytes:Number(descriptor.packedBytes||0)
  };
}

function chunkRecordToDescriptor(record){
  let bounds=null,center=null;
  try{bounds=JSON.parse(record.bounds_json||'null')}catch{}
  try{center=JSON.parse(record.center_json||'null')}catch{}
  return {
    chunkIndex:Number(record.chunk_index||0),
    fileUri:String(record.file_uri||''),
    compression:String(record.compression||'none'),
    format:String(record.format_version||FORMAT_VERSION),
    objectCount:Number(record.object_count||0),
    instanceCount:Number(record.instance_count||0),
    uniqueGeometryCount:Number(record.unique_geometry_count||0),
    bounds,
    center,
    role:String(record.role||'detail'),
    lod:Number(record.lod??2),
    objectIndexMin:Number.isFinite(Number(record.object_index_min))?Number(record.object_index_min):null,
    objectIndexMax:Number.isFinite(Number(record.object_index_max))?Number(record.object_index_max):null,
    rawBytes:Number(record.raw_bytes||0),
    packedBytes:Number(record.packed_bytes||0),
    cacheKey:String(record.cache_key||''),
    versionId:String(record.version_id||''),
    __persisted:true,
    __recordId:record.id||null
  };
}

async function loadChunkDescriptors(cacheKeyValue){
  const rows=await base44.entities.GeometryCacheChunk.filter(
    {cache_key:String(cacheKeyValue||'')},
    'chunk_index',
    5000
  );

  const ordered=(rows||[])
    .map(chunkRecordToDescriptor)
    .sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));

  // Retomadas interrompidas podem deixar chunks órfãos que representam
  // exatamente a mesma geometria. A base deve manter somente a cópia mais
  // recente de cada chunk lógico da integração atual.
  const bySignature=new Map();
  const duplicateIds=[];
  for(const item of ordered){
    const signature=[
      item.role||'detail',
      Number(item.lod??2),
      Number.isFinite(Number(item.objectIndexMin))?Number(item.objectIndexMin):'',
      Number.isFinite(Number(item.objectIndexMax))?Number(item.objectIndexMax):'',
      Number(item.objectCount||0),
      Number(item.instanceCount||0),
      Number(item.uniqueGeometryCount||0),
      Number(item.rawBytes||0),
      Number(item.packedBytes||0),
      JSON.stringify(item.bounds||null),
      JSON.stringify(item.center||null)
    ].join('|');

    const previous=bySignature.get(signature);
    if(previous?.__recordId)duplicateIds.push(previous.__recordId);
    bySignature.set(signature,item);
  }

  if(duplicateIds.length){
    for(let offset=0;offset<duplicateIds.length;offset+=200){
      const ids=duplicateIds.slice(offset,offset+200);
      try{
        await base44.entities.GeometryCacheChunk.deleteMany({id:{$in:ids}});
      }catch{
        for(const id of ids){
          try{await base44.entities.GeometryCacheChunk.delete(id)}catch{}
        }
      }
    }
  }

  return [...bySignature.values()]
    .sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));
}

async function persistChunkDescriptors(manifest,descriptors){
  const fresh=(descriptors||[]).filter(item=>!item.__persisted&&item.fileUri);
  if(!fresh.length)return;

  for(let offset=0;offset<fresh.length;offset+=100){
    let pending=fresh.slice(offset,offset+100);
    let lastError=null;

    for(const delay of [0,1200,3000,6000]){
      if(!pending.length)break;
      if(delay)await wait(delay);
      try{
        const created=await base44.entities.GeometryCacheChunk.bulkCreate(
          pending.map(item=>descriptorToChunkRecord(manifest,item))
        );
        for(let i=0;i<pending.length;i++){
          pending[i].__persisted=true;
          pending[i].__recordId=created?.[i]?.id||null;
        }
        pending=[];
        break;
      }catch(error){
        lastError=error;
        // Se a resposta da criação se perdeu, confirme no banco antes de repetir
        // para evitar registros duplicados.
        try{
          const indices=pending.map(item=>Number(item.chunkIndex));
          const existing=await base44.entities.GeometryCacheChunk.filter({
            cache_key:String(manifest.cache_key||''),
            chunk_index:{$in:indices}
          },'chunk_index',Math.max(100,indices.length));
          const byIndex=new Map((existing||[]).map(row=>[Number(row.chunk_index),row]));
          for(const item of pending){
            const row=byIndex.get(Number(item.chunkIndex));
            if(row){
              item.__persisted=true;
              item.__recordId=row.id||null;
            }
          }
          pending=pending.filter(item=>!item.__persisted);
        }catch{}
      }
    }

    if(pending.length){
      throw lastError||new Error('Falha de rede ao registrar chunks PHD3D.');
    }
  }
}

function cacheKey(connection){
  return [
    connection?.project_id||'',
    connection?.model_id||'',
    connection?.version_id||''
  ].join(':');
}

function toBytes(value){
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(Array.isArray(value))return Uint8Array.from(value);
  return new Uint8Array();
}

async function gzipBytes(bytes){
  if(typeof CompressionStream==='undefined')return {bytes:toBytes(bytes),compression:'none'};
  const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return {bytes:new Uint8Array(await new Response(stream).arrayBuffer()),compression:'gzip'};
}

async function gunzipBytes(bytes,compression){
  if(compression!=='gzip'||typeof DecompressionStream==='undefined')return toBytes(bytes);
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function uniqueGeometryIncrement(object,seen){
  let bytes=160;
  for(const row of object?.rows||[]){
    bytes+=96;
    const geometryIndex=Number(row.geometryIndex);
    if(!Number.isFinite(geometryIndex)||seen.has(geometryIndex))continue;
    seen.add(geometryIndex);
    bytes+=toBytes(row.content).byteLength;
  }
  return bytes;
}

function splitObjects(objects,{maxObjects=MAX_OBJECTS_PER_FILE,maxBytes=MAX_RAW_BYTES}={}){
  const result=[];
  let current=[];
  let currentBytes=0;
  let seen=new Set();

  const flush=()=>{
    if(current.length)result.push(current);
    current=[];
    currentBytes=0;
    seen=new Set();
  };

  for(const object of objects||[]){
    const testSeen=new Set(seen);
    const next=uniqueGeometryIncrement(object,testSeen);

    if(current.length&&(
      current.length>=maxObjects||
      currentBytes+next>maxBytes
    )){
      flush();
    }

    current.push(object);
    currentBytes+=uniqueGeometryIncrement(object,seen);
  }

  flush();
  return result;
}

function boxArray(box){
  if(!finiteBox(box))return null;
  return [box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
}

function centerFromBounds(bounds){
  if(!Array.isArray(bounds)||bounds.length!==6)return null;
  return [
    (Number(bounds[0])+Number(bounds[3]))/2,
    (Number(bounds[1])+Number(bounds[4]))/2,
    (Number(bounds[2])+Number(bounds[5]))/2
  ];
}

function analyzeSpatialObjects(objects,{sort=true}={}){
  const preparedGeometry=new Map();
  const identity=new THREE.Matrix4();

  for(const object of objects||[]){
    for(const row of object?.rows||[]){
      const geometryIndex=Number(row.geometryIndex);
      if(!Number.isFinite(geometryIndex)||preparedGeometry.has(geometryIndex))continue;

      const geometry=createThreeGeometry(row.content);
      if(!geometry){
        preparedGeometry.set(geometryIndex,null);
        continue;
      }

      const position=geometry.getAttribute('position');
      const normal=geometry.getAttribute('normal');
      const index=geometry.getIndex();

      if(!position?.array||!index?.array){
        geometry.dispose?.();
        preparedGeometry.set(geometryIndex,null);
        continue;
      }

      const positions=position.array instanceof Float32Array
        ? position.array
        : Float32Array.from(position.array);
      const normals=normal?.array
        ? (normal.array instanceof Float32Array?normal.array:Float32Array.from(normal.array))
        : new Float32Array(positions.length);
      const indices=index.array instanceof Uint32Array
        ? index.array
        : Uint32Array.from(index.array);
      const bbox=geometry.boundingBox?boxArray(geometry.boundingBox):null;

      preparedGeometry.set(geometryIndex,{
        geometryIndex,
        id:String(row.id||''),
        type:String(row.type||''),
        positions,
        normals,
        indices,
        bbox
      });
      geometry.dispose?.();
    }
  }

  const enriched=[];
  const globalBox=new THREE.Box3().makeEmpty();

  for(const object of objects||[]){
    const objectBox=new THREE.Box3().makeEmpty();
    const preparedRows=[];
    for(const row of object?.rows||[]){
      const prepared=preparedGeometry.get(Number(row.geometryIndex));
      const bounds=prepared?.bbox;
      if(!prepared||!bounds)continue;
      preparedRows.push({...row,__phdPrepared:prepared});
      const box=new THREE.Box3(
        new THREE.Vector3(bounds[0],bounds[1],bounds[2]),
        new THREE.Vector3(bounds[3],bounds[4],bounds[5])
      );
      const hasTransform=row.transform!==null&&row.transform!==undefined&&String(row.transform).length>0;
      const matrix=hasTransform?matrixFromBundleTransform(row.transform):identity;
      if(hasTransform&&!matrix)continue;
      box.applyMatrix4(matrix||identity);
      const size=box.getSize(new THREE.Vector3());
      const values=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
      const sane=finiteBox(box)&&values.every(value=>Math.abs(value)<=1e9)&&size.length()<1e8;
      if(sane)objectBox.union(box);
    }
    const bounds=boxArray(objectBox);
    const center=centerFromBounds(bounds);
    if(bounds)globalBox.union(objectBox);
    enriched.push({...object,rows:preparedRows,__phdBounds:bounds,__phdCenter:center});
  }

  if(!sort||!finiteBox(globalBox))return enriched;

  const min=globalBox.min;
  const size=globalBox.getSize(new THREE.Vector3());
  const sx=Math.max(size.x,1e-9),sy=Math.max(size.y,1e-9),sz=Math.max(size.z,1e-9);

  const key=item=>{
    const c=item.__phdCenter;
    if(!c)return Number.MAX_SAFE_INTEGER;
    const qx=Math.max(0,Math.min(1023,Math.floor(((c[0]-min.x)/sx)*1023)));
    const qy=Math.max(0,Math.min(1023,Math.floor(((c[1]-min.y)/sy)*1023)));
    const qz=Math.max(0,Math.min(1023,Math.floor(((c[2]-min.z)/sz)*1023)));
    return qx*1048576+qy*1024+qz;
  };

  return enriched.sort((a,b)=>key(a)-key(b));
}

function buildBinaryChunk(connection,objects){
  const sources=new Map();
  const objectCandidates=[];

  for(const object of objects||[]){
    const rows=[];
    for(const row of object?.rows||[]){
      const geometryIndex=Number(row.geometryIndex);
      if(!Number.isFinite(geometryIndex))continue;

      if(!sources.has(geometryIndex)){
        const prepared=row.__phdPrepared||null;
        sources.set(geometryIndex,prepared?{
          geometryIndex,
          id:String(prepared.id||row.id||''),
          type:String(prepared.type||row.type||''),
          prepared
        }:{
          geometryIndex,
          id:String(row.id||''),
          type:String(row.type||''),
          content:toBytes(row.content)
        });
      }

      rows.push({
        geometryIndex,
        transform:row.transform?String(row.transform):null
      });
    }

    if(rows.length){
      objectCandidates.push({
        objectIndex:Number(object.objectIndex),
        applicationId:String(object.applicationId||object.objectIndex),
        displayColor:object.displayColor?String(object.displayColor):null,
        rows,
        spatialBounds:Array.isArray(object.__phdBounds)?object.__phdBounds:null
      });
    }
  }

  const decoded=new Map();

  for(const source of sources.values()){
    if(source.prepared){
      decoded.set(source.geometryIndex,source.prepared);
      continue;
    }

    const geometry=createThreeGeometry(source.content);
    if(!geometry)continue;

    const position=geometry.getAttribute('position');
    const normal=geometry.getAttribute('normal');
    const index=geometry.getIndex();

    if(!position?.array||!index?.array){
      geometry.dispose?.();
      continue;
    }

    const positions=position.array instanceof Float32Array
      ? position.array
      : Float32Array.from(position.array);
    const normals=normal?.array
      ? (normal.array instanceof Float32Array?normal.array:Float32Array.from(normal.array))
      : new Float32Array(positions.length);
    const indices=index.array instanceof Uint32Array
      ? index.array
      : Uint32Array.from(index.array);
    const bbox=geometry.boundingBox?boxArray(geometry.boundingBox):null;

    decoded.set(source.geometryIndex,{
      geometryIndex:source.geometryIndex,
      id:source.id,
      type:source.type,
      positions,
      normals,
      indices,
      bbox
    });
    geometry.dispose?.();
  }

  const objectTable=objectCandidates.map(object=>({
    objectIndex:object.objectIndex,
    applicationId:object.applicationId,
    displayColor:object.displayColor||null,
    rows:object.rows.filter(row=>decoded.has(row.geometryIndex)),
    spatialBounds:object.spatialBounds
  })).filter(object=>object.rows.length);

  const geometryTable=[];
  let payloadBytes=0;

  for(const geometry of decoded.values()){
    payloadBytes=align4(payloadBytes);
    const positionOffset=payloadBytes;
    const positionBytes=geometry.positions.byteLength;
    payloadBytes+=positionBytes;

    payloadBytes=align4(payloadBytes);
    const normalOffset=payloadBytes;
    const normalBytes=geometry.normals.byteLength;
    payloadBytes+=normalBytes;

    payloadBytes=align4(payloadBytes);
    const indexOffset=payloadBytes;
    const indexBytes=geometry.indices.byteLength;
    payloadBytes+=indexBytes;

    geometryTable.push({
      geometryIndex:geometry.geometryIndex,
      id:geometry.id,
      type:geometry.type,
      positionOffset,
      positionCount:geometry.positions.length,
      positionBytes,
      normalOffset,
      normalCount:geometry.normals.length,
      normalBytes,
      indexOffset,
      indexCount:geometry.indices.length,
      indexBytes,
      bbox:geometry.bbox
    });
  }

  const chunkBox=new THREE.Box3().makeEmpty();
  for(const object of objectTable){
    const bounds=object.spatialBounds;
    if(!Array.isArray(bounds)||bounds.length!==6)continue;
    const box=new THREE.Box3(
      new THREE.Vector3(bounds[0],bounds[1],bounds[2]),
      new THREE.Vector3(bounds[3],bounds[4],bounds[5])
    );
    if(finiteBox(box))chunkBox.union(box);
  }
  const chunkBounds=boxArray(chunkBox);
  const chunkCenter=centerFromBounds(chunkBounds);

  const header={
    format:FORMAT_VERSION,
    encoding:'gpu-ready-f32-u32',
    projectId:String(connection?.project_id||''),
    modelId:String(connection?.model_id||''),
    versionId:String(connection?.version_id||''),
    objectCount:objectTable.length,
    instanceCount:objectTable.reduce((sum,item)=>sum+item.rows.length,0),
    geometryCount:geometryTable.length,
    objects:objectTable.map(({spatialBounds,...object})=>object),
    geometries:geometryTable,
    chunkBounds,
    chunkCenter
  };

  const headerBytes=new TextEncoder().encode(JSON.stringify(header));
  const payloadStart=align4(PREFIX_BYTES+headerBytes.byteLength);
  const raw=new Uint8Array(payloadStart+payloadBytes);

  raw.set(MAGIC,0);
  new DataView(raw.buffer).setUint32(8,headerBytes.byteLength,true);
  raw.set(headerBytes,PREFIX_BYTES);

  for(const item of geometryTable){
    const geometry=decoded.get(item.geometryIndex);
    if(!geometry)continue;

    raw.set(
      new Uint8Array(geometry.positions.buffer,geometry.positions.byteOffset,geometry.positions.byteLength),
      payloadStart+item.positionOffset
    );
    raw.set(
      new Uint8Array(geometry.normals.buffer,geometry.normals.byteOffset,geometry.normals.byteLength),
      payloadStart+item.normalOffset
    );
    raw.set(
      new Uint8Array(geometry.indices.buffer,geometry.indices.byteOffset,geometry.indices.byteLength),
      payloadStart+item.indexOffset
    );
  }

  const objectIndices=objectTable.map(item=>Number(item.objectIndex)).filter(Number.isFinite);
  return {
    raw,
    objectCount:objectTable.length,
    instanceCount:header.instanceCount,
    uniqueGeometryCount:geometryTable.length,
    bounds:chunkBounds,
    center:chunkCenter,
    objectIndexMin:objectIndices.length?Math.min(...objectIndices):null,
    objectIndexMax:objectIndices.length?Math.max(...objectIndices):null
  };
}

function parseBinaryChunk(raw){
  if(raw.byteLength<PREFIX_BYTES)throw new Error('Chunk PHD3D binário incompleto.');

  for(let i=0;i<MAGIC.length;i++){
    if(raw[i]!==MAGIC[i])throw new Error('Assinatura PHD3D Spatial v3 inválida.');
  }

  const headerLength=new DataView(raw.buffer,raw.byteOffset,raw.byteLength).getUint32(8,true);
  const headerStart=PREFIX_BYTES;
  const headerEnd=headerStart+headerLength;
  if(headerEnd>raw.byteLength)throw new Error('Cabeçalho PHD3D Spatial v3 corrompido.');

  const header=JSON.parse(new TextDecoder().decode(raw.subarray(headerStart,headerEnd)));
  if(header?.format!==FORMAT_VERSION)throw new Error('Versão PHD3D incompatível.');

  const payloadStart=align4(headerEnd);
  const geometryMap=new Map();

  for(const geometry of header.geometries||[]){
    const positionByteOffset=raw.byteOffset+payloadStart+Number(geometry.positionOffset||0);
    const normalByteOffset=raw.byteOffset+payloadStart+Number(geometry.normalOffset||0);
    const indexByteOffset=raw.byteOffset+payloadStart+Number(geometry.indexOffset||0);

    const positionCount=Number(geometry.positionCount||0);
    const normalCount=Number(geometry.normalCount||0);
    const indexCount=Number(geometry.indexCount||0);

    if(
      !positionCount||
      !indexCount||
      positionByteOffset+positionCount*4>raw.byteOffset+raw.byteLength||
      indexByteOffset+indexCount*4>raw.byteOffset+raw.byteLength
    )continue;

    const positions=new Float32Array(raw.buffer,positionByteOffset,positionCount);
    const normals=normalCount
      ? new Float32Array(raw.buffer,normalByteOffset,normalCount)
      : null;
    const indices=new Uint32Array(raw.buffer,indexByteOffset,indexCount);

    geometryMap.set(Number(geometry.geometryIndex),{
      geometryIndex:Number(geometry.geometryIndex),
      id:String(geometry.id||''),
      type:String(geometry.type||''),
      phdGeometry:{
        positions,
        normals,
        indices,
        bbox:Array.isArray(geometry.bbox)?geometry.bbox.map(Number):null
      }
    });
  }

  return (header.objects||[]).map(object=>({
    objectIndex:Number(object.objectIndex),
    applicationId:String(object.applicationId||object.objectIndex),
    displayColor:object.displayColor?String(object.displayColor):null,
    rows:(object.rows||[]).map(row=>{
      const geometry=geometryMap.get(Number(row.geometryIndex));
      if(!geometry)return null;
      return {
        ...geometry,
        transform:row.transform?String(row.transform):null
      };
    }).filter(Boolean)
  })).filter(object=>object.rows.length);
}

async function uploadOnePrepared(item,onRetry){
  let uploaded=null;
  let lastError=null;

  for(let attempt=0;attempt<UPLOAD_RETRY_DELAYS.length;attempt++){
    const delay=UPLOAD_RETRY_DELAYS[attempt];
    if(delay)await wait(delay);

    try{
      uploaded=await base44.integrations.Core.UploadPrivateFile({file:item.file});
      if(!uploaded?.file_uri)throw new Error('Upload concluído sem file_uri.');
      break;
    }catch(error){
      lastError=error;
      onRetry?.({
        chunkIndex:item.chunkIndex,
        attempt:attempt+1,
        maxAttempts:UPLOAD_RETRY_DELAYS.length,
        delayMs:attempt+1<UPLOAD_RETRY_DELAYS.length?UPLOAD_RETRY_DELAYS[attempt+1]:0,
        error
      });
    }
  }

  if(!uploaded?.file_uri){
    const message=lastError?.message||String(lastError||'Falha no upload do chunk PHD3D.');
    const error=new Error('Falha no upload do chunk '+item.chunkIndex+' após '+UPLOAD_RETRY_DELAYS.length+' tentativas: '+message);
    error.code='PHD_CACHE_UPLOAD_FAILED';
    error.chunkIndex=item.chunkIndex;
    throw error;
  }

  return {
    chunkIndex:item.chunkIndex,
    fileUri:String(uploaded.file_uri||''),
    compression:item.compression,
    format:FORMAT_VERSION,
    objectCount:item.objectCount,
    instanceCount:item.instanceCount,
    uniqueGeometryCount:item.uniqueGeometryCount,
    bounds:item.bounds||null,
    center:item.center||null,
    role:item.role||'detail',
    lod:Number(item.lod??2),
    objectIndexMin:Number.isFinite(Number(item.objectIndexMin))?Number(item.objectIndexMin):null,
    objectIndexMax:Number.isFinite(Number(item.objectIndexMax))?Number(item.objectIndexMax):null,
    rawBytes:item.rawBytes,
    packedBytes:item.packedBytes
  };
}

async function hydrateGeometryCacheManifest(manifest,key){
  if(!manifest)return null;

  let chunks=await readLocalDescriptorIndex(manifest);
  if(!chunks?.length)chunks=await loadChunkDescriptors(key);
  if(!chunks.length){
    const legacy=parseManifestChunks(manifest);
    if(legacy.length){
      await persistChunkDescriptors(manifest,legacy);
      chunks=legacy;
      await updateManifestRecord(manifest.id,{chunks_json:'[]'});
    }
  }
  if(!chunks.length)return null;
  void writeLocalDescriptorIndex(manifest,chunks);
  return {...manifest,chunks};
}

export async function findReadyGeometryCache(connection){
  const key=cacheKey(connection);
  const rows=await base44.entities.GeometryCacheManifest.filter({
    cache_key:key,
    status:'ready',
    format_version:FORMAT_VERSION
  },'-updated_date',5);
  return hydrateGeometryCacheManifest(rows?.[0],key);
}

export async function findUsableGeometryCache(connection){
  const key=cacheKey(connection);
  const rows=await base44.entities.GeometryCacheManifest.filter({
    cache_key:key,
    format_version:FORMAT_VERSION
  },'-updated_date',5);

  const manifest=(rows||[]).find(item=>
    ['ready','building','partial','error'].includes(String(item?.status||''))&&
    Number(item?.cached_chunks||0)>0
  );
  return hydrateGeometryCacheManifest(manifest,key);
}

export async function loadGeometrySourceIndex(manifest){
  const fileUri=String(manifest?.source_index_uri||'');
  if(!fileUri)return [];

  let lastError=null;
  for(const delay of [0,1200,3000]){
    if(delay)await wait(delay);
    try{
      const signed=await base44.integrations.Core.CreateFileSignedUrl({
        file_uri:fileUri,
        expires_in:3600
      });
      if(!signed?.signed_url)throw new Error('URL assinada do índice PHD3D não foi retornada.');
      const response=await fetch(signed.signed_url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('Índice PHD3D HTTP '+response.status);
      const buffer=await response.arrayBuffer();
      if(!buffer.byteLength||buffer.byteLength%4!==0){
        throw new Error('Índice PHD3D inválido: tamanho incompatível com Uint32.');
      }
      return Array.from(new Uint32Array(buffer));
    }catch(error){
      lastError=error;
    }
  }
  throw lastError||new Error('Falha ao carregar o índice PHD3D salvo.');
}

export async function pruneGeometryCacheDuplicates(connection){
  const key=cacheKey(connection);
  const rows=await base44.entities.GeometryCacheManifest.filter({
    cache_key:key,
    format_version:FORMAT_VERSION
  },'-updated_date',5);
  const manifest=rows?.[0]||null;
  if(!manifest)return {removed:0,chunks:0};

  const before=Number(manifest.cached_chunks||manifest.total_chunks||0);
  const chunks=await loadChunkDescriptors(key);
  const totalBytes=chunks.reduce((sum,item)=>sum+Number(item.packedBytes||0),0);
  const removed=Math.max(0,before-chunks.length);

  if(chunks.length&&(
    Number(manifest.cached_chunks||0)!==chunks.length||
    Number(manifest.total_chunks||0)!==chunks.length||
    Number(manifest.total_bytes||0)!==totalBytes
  )){
    await updateManifestRecord(manifest.id,{
      cached_chunks:chunks.length,
      total_chunks:chunks.length,
      total_bytes:totalBytes,
      last_checkpoint_at:new Date().toISOString()
    });
  }

  if(chunks.length)void writeLocalDescriptorIndex({...manifest,cached_chunks:chunks.length,total_chunks:chunks.length,total_bytes:totalBytes},chunks);
  return {removed,chunks:chunks.length,totalBytes};
}

export async function beginGeometryCacheBuild(connection,totalObjects,{totalBatches=0,batchSize=0,resume=true}={}){
  const key=cacheKey(connection);
  const existingRows=await base44.entities.GeometryCacheManifest.filter({cache_key:key},'-updated_date',5);
  const existing=existingRows?.[0]||null;
  let existingChunks=existing?await loadChunkDescriptors(key):[];

  if(existing&&!existingChunks.length){
    const legacy=parseManifestChunks(existing);
    if(legacy.length){
      await persistChunkDescriptors(existing,legacy);
      existingChunks=legacy;
      await updateManifestRecord(existing.id,{chunks_json:'[]'});
    }
  }

  const canResume=!!(
    resume&&
    existing&&
    existing.format_version===FORMAT_VERSION&&
    ['building','partial','error'].includes(existing.status)&&
    Number(existing.next_batch_index||0)>=0&&
    Number(existing.cached_chunks||0)>0&&
    existingChunks.length
  );

  if(canResume){
    const previousBatchSize=Number(existing.preparation_batch_size||0)||768;
    const hasSavedOffset=existing.next_object_offset!==undefined&&existing.next_object_offset!==null;
    const completedBatches=Number(existing.next_batch_index||0);
    const previewObjects=existingChunks
      .filter(item=>item.role==='preview'||Number(item.lod)===0)
      .reduce((sum,item)=>sum+Number(item.objectCount||0),0);
    const preparedDetail=Math.max(0,Number(existing.cached_objects||0)-previewObjects);
    const inferredLegacyBatchSize=completedBatches>0
      ? Math.round(preparedDetail/completedBatches)
      : previousBatchSize;
    const safeLegacyBatchSize=inferredLegacyBatchSize>=128&&inferredLegacyBatchSize<=8192
      ? inferredLegacyBatchSize
      : previousBatchSize;
    const resumeObjectOffset=hasSavedOffset
      ? Number(existing.next_object_offset||0)
      : completedBatches*safeLegacyBatchSize;
    const resumeTotal=Number(totalObjects||existing.total_objects||0);
    const resumeCached=Number(existing.cached_objects||0);
    const resumeProgress=resumeTotal
      ? Math.min(99.9,(resumeCached/resumeTotal)*100)
      : Number(existing.ingest_progress||0);
    const payload={
      status:'building',
      total_objects:resumeTotal,
      total_batches:Number(totalBatches||existing.total_batches||0),
      preparation_batch_size:Number(batchSize||existing.preparation_batch_size||0),
      error_message:'',
      completed_at:'',
      last_checkpoint_at:new Date().toISOString(),
      server_side:false,
      ingest_phase:'viewer-ready-browser',
      ingest_progress:Math.round(resumeProgress*10)/10,
      ingest_detail:'Retomada no navegador a partir do último checkpoint válido. O progresso agora usa o cache PHD3D real.',
      source:'Speckle Bundle → PHD3D Spatial v3 · Browser Resume'
    };
    await updateManifestRecord(existing.id,payload);
    return {
      ...existing,
      ...payload,
      id:existing.id,
      chunks:existingChunks,
      resumed:true,
      resumeObjectOffset
    };
  }

  const payload={
    project_id:String(connection?.project_id||''),
    model_id:String(connection?.model_id||''),
    version_id:String(connection?.version_id||''),
    cache_key:key,
    status:'building',
    format_version:FORMAT_VERSION,
    total_objects:Number(totalObjects||0),
    cached_objects:0,
    total_chunks:0,
    cached_chunks:0,
    total_bytes:0,
    chunks_json:'[]',
    source:'Speckle Bundle → PHD3D Spatial v3',
    completed_at:'',
    error_message:'',
    next_batch_index:0,
    total_batches:Number(totalBatches||0),
    next_object_offset:0,
    preparation_batch_size:Number(batchSize||0),
    last_checkpoint_at:new Date().toISOString(),
    upload_failures:0,
    server_side:false,
    ingest_phase:'browser-preparation',
    ingest_progress:0,
    ingest_detail:'Preparação PHD3D executada no navegador com checkpoint incremental.'
  };

  if(existing){
    try{await base44.entities.GeometryCacheChunk.deleteMany({cache_key:key})}catch{}
    await updateManifestRecord(existing.id,payload);
    return {...existing,...payload,id:existing.id,chunks:[],resumed:false,resumeObjectOffset:0};
  }

  const created=await base44.entities.GeometryCacheManifest.create(payload);
  return {...created,...payload,chunks:[],resumed:false,resumeObjectOffset:0};
}

export async function prepareGeometryCacheFiles(
  connection,
  objects,
  startChunkIndex=0,
  {role='detail',lod=2,spatial=true}={}
){
  const analyzed=analyzeSpatialObjects(objects,{sort:spatial});
  let groups=splitObjects(analyzed,{
    maxObjects:role==='detail'&&spatial?SPATIAL_OBJECTS_PER_CHUNK:MAX_OBJECTS_PER_FILE,
    maxBytes:MAX_RAW_BYTES
  });
  if(role==='preview'&&groups.length>1){
    groups=[analyzed.slice(0,PREVIEW_OBJECTS)];
  }
  const binaries=[];
  let chunkIndex=Number(startChunkIndex)||0;

  for(const group of groups){
    const binary=buildBinaryChunk(connection,group);
    if(!binary.objectCount)continue;
    binaries.push({binary,fileIndex:chunkIndex++});
  }

  const prepared=await mapConcurrent(binaries,4,async item=>{
    const packed=await gzipBytes(item.binary.raw);
    return {
      chunkIndex:item.fileIndex,
      file:new File(
        [packed.bytes],
        'phd3d-'+String(connection?.version_id||'model')+'-'+String(item.fileIndex).padStart(5,'0')+'.phd3d'+(packed.compression==='gzip'?'.gz':''),
        {type:packed.compression==='gzip'?'application/gzip':'application/octet-stream'}
      ),
      compression:packed.compression,
      objectCount:item.binary.objectCount,
      instanceCount:item.binary.instanceCount,
      uniqueGeometryCount:item.binary.uniqueGeometryCount,
      bounds:item.binary.bounds,
      center:item.binary.center,
      role,
      lod:Number(lod),
      objectIndexMin:item.binary.objectIndexMin,
      objectIndexMax:item.binary.objectIndexMax,
      rawBytes:item.binary.raw.byteLength,
      packedBytes:packed.bytes.byteLength
    };
  });

  return prepared.sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));
}

export async function uploadPreparedGeometryCacheFiles(prepared,{onRetry,concurrency=UPLOAD_CONCURRENCY}={}){
  const items=[...(prepared||[])];
  if(!items.length)return [];

  const results=new Array(items.length);
  let cursor=0;
  const workerCount=Math.max(1,Math.min(Number(concurrency)||UPLOAD_CONCURRENCY,items.length));

  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=items.length)return;
      results[index]=await uploadOnePrepared(items[index],onRetry);
    }
  };

  await Promise.all(Array.from({length:workerCount},()=>worker()));
  return results.filter(Boolean).sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));
}

export async function updateGeometryCacheManifest(
  manifest,
  chunks,
  cachedObjects,
  status='building',
  errorMessage='',
  {
    nextBatchIndex=manifest?.next_batch_index||0,
    totalBatches=manifest?.total_batches||0,
    nextObjectOffset=manifest?.next_object_offset||0,
    preparationBatchSize=manifest?.preparation_batch_size||0,
    uploadFailures=manifest?.upload_failures||0
  }={}
){
  const safeChunks=[...(chunks||[])].sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex));
  const totalBytes=safeChunks.reduce((sum,item)=>sum+Number(item.packedBytes||0),0);
  const now=new Date().toISOString();
  const totalObjects=Number(manifest.total_objects||cachedObjects||0);
  const coverage=totalObjects
    ? Math.min(100,(Number(cachedObjects||0)/totalObjects)*100)
    : status==='ready'?100:0;
  const liveProgress=status==='ready'?100:Math.round(coverage*10)/10;

  await persistChunkDescriptors(manifest,safeChunks);

  const payload={
    status,
    format_version:FORMAT_VERSION,
    total_objects:totalObjects,
    cached_objects:Number(cachedObjects||0),
    cached_chunks:safeChunks.length,
    total_chunks:safeChunks.length,
    total_bytes:totalBytes,
    chunks_json:'[]',
    completed_at:status==='ready'?now:'',
    error_message:String(errorMessage||''),
    next_batch_index:Number(nextBatchIndex||0),
    total_batches:Number(totalBatches||0),
    next_object_offset:Number(nextObjectOffset||0),
    preparation_batch_size:Number(preparationBatchSize||0),
    last_checkpoint_at:now,
    upload_failures:Number(uploadFailures||0),
    server_side:false,
    ingest_phase:status==='ready'?'ready':Number(cachedObjects||0)>0?'viewer-ready-browser':'browser-preparation',
    ingest_progress:liveProgress,
    ingest_detail:status==='ready'
      ? 'Modelo PHD3D preparado integralmente. Cache atual concluído.'
      : status==='partial'
        ? 'Preparação pausada no navegador. Checkpoint preservado para continuar sem reiniciar.'
        : status==='error'
          ? String(errorMessage||'Falha na preparação PHD3D.')
          : Number(cachedObjects||0).toLocaleString('pt-BR')+' / '+totalObjects.toLocaleString('pt-BR')+
            ' objetos preparados no cache PHD3D atual.',
    source:'Speckle Bundle → PHD3D Spatial v3 · Browser Pipeline'
  };

  await updateManifestRecord(manifest.id,payload);
  const updated={...manifest,...payload,chunks:safeChunks};
  if(status==='ready')void writeLocalDescriptorIndex(updated,safeChunks);
  return updated;
}

export function computeGeometryCacheObjectsBounds(objects){
  const identity=new THREE.Matrix4();
  const globalBox=new THREE.Box3().makeEmpty();
  let valid=0,invalid=0;

  for(const object of objects||[]){
    for(const row of object?.rows||[]){
      const bounds=row?.phdGeometry?.bbox;
      if(!Array.isArray(bounds)||bounds.length!==6){invalid++;continue}
      const box=new THREE.Box3(
        new THREE.Vector3(Number(bounds[0]),Number(bounds[1]),Number(bounds[2])),
        new THREE.Vector3(Number(bounds[3]),Number(bounds[4]),Number(bounds[5]))
      );
      const hasTransform=row.transform!==null&&row.transform!==undefined&&String(row.transform).length>0;
      const matrix=hasTransform?matrixFromBundleTransform(row.transform):identity;
      if(hasTransform&&!matrix){invalid++;continue}
      box.applyMatrix4(matrix||identity);
      const size=box.getSize(new THREE.Vector3());
      const values=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
      if(!finiteBox(box)||values.some(value=>Math.abs(value)>1e9)||size.length()>=1e8){invalid++;continue}
      globalBox.union(box);
      valid++;
    }
  }

  const bounds=boxArray(globalBox);
  return {bounds,center:centerFromBounds(bounds),valid,invalid};
}

export async function repairGeometryCacheChunkBounds(descriptor,objects){
  const result=computeGeometryCacheObjectsBounds(objects);
  if(!result.bounds)return result;
  descriptor.bounds=result.bounds;
  descriptor.center=result.center;
  if(descriptor.__recordId){
    try{
      await base44.entities.GeometryCacheChunk.update(descriptor.__recordId,{
        bounds_json:JSON.stringify(result.bounds),
        center_json:JSON.stringify(result.center)
      });
      await invalidateLocalDescriptorIndex(descriptor.cacheKey);
    }catch{}
  }
  return result;
}

async function loadGeometryCacheChunkInternal(descriptor){
  const decode=async(packed,source)=>{
    if(!packed?.byteLength)return null;
    const raw=await gunzipBytes(packed,descriptor?.compression);
    const objects=parseBinaryChunk(raw);
    await applyLocalChunkColors(descriptor,objects);
    descriptor.__cacheSource=source;
    return objects;
  };

  // 1) Fast OPFS
  try{
    const packed=await readFastPackedChunk(descriptor);
    const objects=await decode(packed,'fast');
    if(objects)return objects;
  }catch{
    const key=String(descriptor?.cacheKey||'');
    fastIndexMemory.delete(key);
    for(const memoryKey of [...fastPackMemory.keys()]){
      if(memoryKey.startsWith(key+'|'))fastPackMemory.delete(memoryKey);
    }
  }

  // 2) Chunk individual no OPFS
  try{
    const packed=await readLocalPackedChunk(descriptor);
    const objects=await decode(packed,'local');
    if(objects)return objects;
  }catch{
    await deleteLocalPackedChunk(descriptor);
  }

  // 3) HyperView Render Pack do servidor. Se funcionar, aquece OPFS para a
  // próxima abertura sem bloquear a renderização atual.
  try{
    const packed=await readHyperViewPackedChunk(descriptor);
    const objects=await decode(packed,'render-pack');
    if(objects){
      await writeLocalPackedChunk(descriptor,packed);
      return objects;
    }
  }catch{
    // cai para o arquivo PHD3D individual
  }

  // 4) Último fallback: arquivo PHD3D individual.
  let packed=null,lastError=null;
  for(const delay of [0,1200,3000]){
    if(delay)await wait(delay);
    try{
      const signed=await base44.integrations.Core.CreateFileSignedUrl({
        file_uri:String(descriptor?.fileUri||''),
        expires_in:3600
      });
      const response=await fetch(signed.signed_url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('Cache PHD HTTP '+response.status);
      packed=new Uint8Array(await response.arrayBuffer());
      break;
    }catch(error){
      lastError=error;
    }
  }
  if(!packed)throw lastError||new Error('Falha ao baixar chunk PHD3D.');

  const objects=await decode(packed,'network');
  // Só persiste depois de validar/decomprimir o binário.
  await writeLocalPackedChunk(descriptor,packed);
  return objects;
}

export async function loadGeometryCacheChunk(descriptor){
  const key=localChunkFileName(descriptor);
  if(localChunkLoadInflight.has(key))return localChunkLoadInflight.get(key);
  const promise=loadGeometryCacheChunkInternal(descriptor)
    .finally(()=>localChunkLoadInflight.delete(key));
  localChunkLoadInflight.set(key,promise);
  return promise;
}

export async function markGeometryCacheError(manifest,error){
  if(!manifest?.id)return;

  try{
    const chunks=parseManifestChunks(manifest);
    const hasProgress=Number(manifest.cached_objects||0)>0||Number(manifest.cached_chunks||0)>0||chunks.length>0;
    await updateManifestRecord(manifest.id,{
      status:hasProgress?'partial':'error',
      error_message:String(error?.message||error||'Falha ao montar cache PHD.'),
      last_checkpoint_at:new Date().toISOString()
    });
  }catch{
    // Não bloquear o viewer por falha do cache.
  }
}

export { FORMAT_VERSION as PHD_GEOMETRY_CACHE_VERSION };
