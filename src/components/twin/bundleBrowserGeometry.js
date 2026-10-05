import { asyncBufferFromUrl, cachedAsyncBuffer, parquetReadObjects } from 'hyparquet';
import { decompress as decompressZstd } from 'fzstd';
import { bundleApi } from '@/components/speckle/bundleApi';

const artifactCache=new Map();
const fileCache=new Map();
const materialColorClientCache=new Map();
const fullMaterialColorClientCache=new Map();
const collectionGroupClientCache=new Map();
const INDEX_DB='phd-native-viewer-index-v2';
const INDEX_STORE='renderable-indices';
const MATERIAL_RESOLVER_VERSION='appearance-v4';

export function invalidateBundleGeometryCache(connection){
  const key=[connection?.project_id,connection?.model_id,connection?.version_id].join(':');
  artifactCache.delete(key);
  for(const materialKey of [...materialColorClientCache.keys()]){
    if(materialKey===key||materialKey.startsWith(key+':'))materialColorClientCache.delete(materialKey);
  }
  for(const materialKey of [...fullMaterialColorClientCache.keys()]){
    if(materialKey===key||materialKey.startsWith(key+':'))fullMaterialColorClientCache.delete(materialKey);
  }
  for(const groupKey of [...collectionGroupClientCache.keys()]){
    if(groupKey===key||groupKey.startsWith(key+':'))collectionGroupClientCache.delete(groupKey);
  }
  fileCache.clear();
}

function openIndexDb(){
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return new Promise(resolve=>{
    const request=indexedDB.open(INDEX_DB,1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(INDEX_STORE))db.createObjectStore(INDEX_STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>resolve(null);
  });
}

async function readIndexCache(key){
  const db=await openIndexDb();
  if(!db)return null;
  return new Promise(resolve=>{
    const tx=db.transaction(INDEX_STORE,'readonly');
    const request=tx.objectStore(INDEX_STORE).get(key);
    request.onsuccess=()=>{
      const value=request.result;
      if(value instanceof Uint32Array)resolve([...value]);
      else if(Array.isArray(value))resolve(value.map(Number).filter(Number.isFinite));
      else resolve(null);
    };
    request.onerror=()=>resolve(null);
  });
}

async function writeIndexCache(key,indices){
  const db=await openIndexDb();
  if(!db)return;
  await new Promise(resolve=>{
    const tx=db.transaction(INDEX_STORE,'readwrite');
    tx.objectStore(INDEX_STORE).put(Uint32Array.from(indices),key);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>resolve();
    tx.onabort=()=>resolve();
  });
}

function asBytes(input){
  if(input instanceof Uint8Array)return input;
  if(input instanceof ArrayBuffer)return new Uint8Array(input);
  if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  if(Array.isArray(input))return Uint8Array.from(input);
  if(input?.buffer instanceof ArrayBuffer)return new Uint8Array(input.buffer,input.byteOffset||0,input.byteLength||input.length||0);
  return new Uint8Array(input||[]);
}

const textDecoder=new TextDecoder();
function decodeText(value){
  if(typeof value==='string')return value;
  if(value instanceof Uint8Array)return textDecoder.decode(value);
  if(value?.buffer instanceof ArrayBuffer)return textDecoder.decode(new Uint8Array(value.buffer,value.byteOffset||0,value.byteLength||value.length||0));
  return String(value||'');
}

const compressors={
  ZSTD:input=>decompressZstd(asBytes(input))
};

const NETWORK_RETRY_DELAYS=[0,1200,3000,6000];

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function transientNetworkError(error){
  const message=String(error?.message||error||'').toLowerCase();
  return message.includes('network')||
    message.includes('failed to fetch')||
    message.includes('fetch failed')||
    message.includes('timeout')||
    message.includes('aborted')||
    message.includes('503')||message.includes('502')||message.includes('504')||message.includes('429')||
    message.includes('403')||message.includes('401');
}

async function retryNetwork(fn,{onRetry}={}){
  let lastError=null;
  for(let attempt=0;attempt<NETWORK_RETRY_DELAYS.length;attempt++){
    const delay=NETWORK_RETRY_DELAYS[attempt];
    if(delay)await wait(delay);
    try{return await fn(attempt)}catch(error){
      lastError=error;
      if(!transientNetworkError(error)||attempt===NETWORK_RETRY_DELAYS.length-1)throw error;
      onRetry?.({attempt:attempt+1,maxAttempts:NETWORK_RETRY_DELAYS.length,error,delayMs:NETWORK_RETRY_DELAYS[attempt+1]||0});
    }
  }
  throw lastError||new Error('Falha de rede ao acessar o Bundle.');
}

const timedFetch=async(input,init={})=>retryNetwork(async()=>{
  const response=await fetch(input,{...init,signal:AbortSignal.timeout(60000)});
  if(!response.ok&&[429,502,503,504].includes(response.status)){
    throw new Error('HTTP '+response.status+' ao acessar artifact do Bundle');
  }
  return response;
});

async function artifactFiles(connection){
  const key=[connection?.project_id,connection?.model_id,connection?.version_id].join(':');
  const hit=artifactCache.get(key);
  if(hit&&Date.now()-hit.at<20*60*1000)return hit.files;

  const data=await retryNetwork(()=>bundleApi('geometryArtifacts',connection,{}));
  const files=data?.files||{};
  if(!files.relations?.url||!files.nodes?.url||!files.geometries?.length){
    throw new Error('Bundle não retornou relations/nodes/geometries para o renderer local.');
  }
  artifactCache.set(key,{at:Date.now(),files});
  return files;
}

async function openParquet(file){
  const url=String(file?.url||'');
  if(!url)throw new Error('Artifact sem URL assinada.');
  if(fileCache.has(url))return fileCache.get(url);

  const promise=(async()=>{
    const size=Number(file?.size)||0;
    if(!size)throw new Error('Artifact sem tamanho conhecido: '+String(file?.name||'parquet'));
    const remote=await asyncBufferFromUrl({
      url,
      byteLength:size,
      fetch:timedFetch
    });
    return cachedAsyncBuffer(remote,{minSize:512*1024});
  })();

  fileCache.set(url,promise);
  try{return await promise}
  catch(error){
    fileCache.delete(url);
    throw error;
  }
}

async function readRows(file,columns,filter,options={}){
  const url=String(file?.url||'');
  return retryNetwork(async attempt=>{
    if(attempt>0&&url)fileCache.delete(url);
    try{
      return await parquetReadObjects({
        file:await openParquet(file),
        columns,
        filter,
        filterStrict:false,
        compressors,
        usePageIndex:true,
        useBloomFilters:true,
        ...options
      });
    }catch(error){
      if(url)fileCache.delete(url);
      throw error;
    }
  });
}

export async function listRenderableObjectIndices(connection,{limit=1000000,onProgress}={}){
  const progress=(value,detail)=>onProgress?.(Math.max(0,Math.min(1,value)),detail);
  const cacheKey=[connection?.project_id,connection?.model_id,connection?.version_id].join(':');
  const cached=await readIndexCache(cacheKey);
  if(cached?.length){
    const result=cached.slice(0,limit);
    progress(1,'Índice local reutilizado · '+result.length.toLocaleString('pt-BR')+' objeto(s)');
    return result;
  }
  progress(.05,'Abrindo relações do Envelope');
  const files=await artifactFiles(connection);
  const rows=await readRows(
    files.relations,
    ['rel','src'],
    {rel:{$in:[1,2,8]}}
  );
  progress(.72,rows.length+' relação(ões) de geometria analisadas');
  const indices=[];
  const seen=new Set();
  for(const row of rows){
    const src=Number(row.src);
    if(!Number.isFinite(src)||seen.has(src))continue;
    seen.add(src);
    indices.push(src);
    if(indices.length>=limit)break;
  }
  void writeIndexCache(cacheKey,indices);
  progress(1,indices.length.toLocaleString('pt-BR')+' objeto(s) renderizável(is) localizado(s)');
  return indices;
}

export async function loadBundleCollectionGroups(connection){
  const key=[connection?.project_id,connection?.model_id,connection?.version_id,'collections-v1'].join(':');
  const hit=collectionGroupClientCache.get(key);
  if(hit)return hit;
  const promise=retryNetwork(()=>bundleApi('collectionColorGroups',connection,{}))
    .then(data=>data?.groups||[]);
  collectionGroupClientCache.set(key,promise);
  try{
    const groups=await promise;
    collectionGroupClientCache.set(key,Promise.resolve(groups));
    return groups;
  }catch(error){
    collectionGroupClientCache.delete(key);
    throw error;
  }
}

export async function loadBundleMaterialColorMap(connection){
  const key=[connection?.project_id,connection?.model_id,connection?.version_id,MATERIAL_RESOLVER_VERSION].join(':');
  if(fullMaterialColorClientCache.has(key))return fullMaterialColorClientCache.get(key);

  const promise=retryNetwork(async()=>{
    const data=await bundleApi('materialColorGroups',connection,{});
    const colors=new Map();
    for(const group of data?.groups||[]){
      const color=String(group?.color||'');
      if(!color)continue;
      for(const rawIndex of group?.objectIndices||[]){
        const objectIndex=Number(rawIndex);
        if(Number.isFinite(objectIndex))colors.set(objectIndex,color);
      }
    }
    return colors;
  });

  fullMaterialColorClientCache.set(key,promise);
  try{
    const colors=await promise;
    // Alimenta também o cache de consultas pontuais.
    materialColorClientCache.set(key,new Map(colors));
    fullMaterialColorClientCache.set(key,Promise.resolve(colors));
    return colors;
  }catch(error){
    fullMaterialColorClientCache.delete(key);
    throw error;
  }
}

export async function loadBundleMaterialColors(connection,objectIndices){
  const indices=[...new Set((objectIndices||[]).map(Number).filter(Number.isFinite))].slice(0,5000);
  if(!indices.length)return new Map();
  const key=[connection?.project_id,connection?.model_id,connection?.version_id,MATERIAL_RESOLVER_VERSION].join(':');

  // Se o mapa global já estiver em memória, a consulta é local e instantânea.
  if(fullMaterialColorClientCache.has(key)){
    try{
      const global=await fullMaterialColorClientCache.get(key);
      return new Map(indices.map(index=>[index,global.get(index)]).filter(([,color])=>!!color));
    }catch{}
  }

  let cache=materialColorClientCache.get(key);
  if(!cache){cache=new Map();materialColorClientCache.set(key,cache)}
  const missing=indices.filter(index=>!cache.has(index));
  if(missing.length){
    try{
      const data=await retryNetwork(()=>bundleApi('materialColorsBatch',connection,{objectIndices:missing}));
      const colors=data?.colors||{};
      for(const index of missing)cache.set(index,colors[String(index)]||null);
    }catch{
      for(const index of missing)cache.set(index,null);
    }
  }
  return new Map(indices.map(index=>[index,cache.get(index)]).filter(([,color])=>!!color));
}

export async function loadBundleGeometryBatch(connection,objectIndices,{limit=320,maxObjects=4096,includeMaterialColors=false,onProgress}={}){
  const indices=[...new Set((objectIndices||[]).map(Number).filter(Number.isFinite))].slice(0,Math.max(1,Number(maxObjects)||4096));
  if(!indices.length)return {objects:[],objectCount:0,meshCount:0};

  const progress=(value,detail)=>onProgress?.(Math.max(0,Math.min(1,value)),detail);
  progress(.03,'Obtendo URLs assinadas dos artifacts');

  const files=await artifactFiles(connection);
  progress(.08,'Abrindo tabela de relações do Envelope');

  const relations=await readRows(
    files.relations,
    ['rel','src','dst','ord'],
    {src:{$in:indices}}
  );
  progress(.22,relations.length+' relação(ões) DISPLAY/INSTANCE candidatas');

  const direct=[];
  const instanceRel=[];
  for(const row of relations){
    const rel=Number(row.rel),src=Number(row.src),dst=Number(row.dst);
    if(!Number.isFinite(src)||!Number.isFinite(dst))continue;
    if(rel===1||rel===2)direct.push({objectIndex:src,geometryIndex:dst,transform:null});
    if(rel===8)instanceRel.push({objectIndex:src,nodeId:dst});
  }

  const instanceIds=[...new Set(instanceRel.map(item=>item.nodeId))];
  const instancesByNode=new Map(instanceRel.map(item=>[item.nodeId,item]));
  const definitionTargets=[];

  if(instanceIds.length){
    progress(.28,'Resolvendo '+instanceIds.length+' instância(s) do Envelope');
    const nodeRows=await readRows(
      files.nodes,
      ['id','def_ref','transform'],
      {id:{$in:instanceIds}}
    );
    const definitions=[];
    for(const row of nodeRows){
      const instance=instancesByNode.get(Number(row.id));
      const def=Number(row.def_ref);
      if(!instance||!Number.isFinite(def))continue;
      definitions.push({objectIndex:instance.objectIndex,definition:def,transform:row.transform??null});
    }

    const defIds=[...new Set(definitions.map(item=>item.definition))];
    if(defIds.length){
      progress(.38,'Resolvendo geometria de '+defIds.length+' definição(ões)');
      const defRels=await readRows(
        files.relations,
        ['rel','src','dst'],
        {$and:[{src:{$in:defIds}},{rel:{$eq:4}}]}
      );
      const definitionsById=new Map();
      for(const item of definitions){
        const list=definitionsById.get(item.definition)||[];
        list.push(item);
        definitionsById.set(item.definition,list);
      }
      for(const row of defRels){
        const src=Number(row.src),dst=Number(row.dst);
        if(!Number.isFinite(dst))continue;
        for(const item of definitionsById.get(src)||[]){
          definitionTargets.push({objectIndex:item.objectIndex,geometryIndex:dst,transform:item.transform});
        }
      }
    }
  }

  const targets=[...direct,...definitionTargets];
  const byGeometry=new Map();
  for(const target of targets){
    if(!Number.isFinite(target.geometryIndex))continue;
    const list=byGeometry.get(target.geometryIndex)||[];
    list.push(target);
    byGeometry.set(target.geometryIndex,list);
  }

  const geometryIndices=[...byGeometry.keys()];
  if(!geometryIndices.length){
    throw new Error('Nenhuma relação DISPLAY/SOLID foi encontrada para os objetos piloto.');
  }

  progress(.46,geometryIndices.length+' índice(s) de geometria localizado(s)');

  const geometryRows=new Map();
  let remaining=new Set(geometryIndices);
  const shards=files.geometries||[];

  for(let i=0;i<shards.length&&remaining.size;i++){
    const shard=shards[i];
    progress(.50+(i/Math.max(shards.length,1))*.42,'Lendo shard '+(i+1)+' de '+shards.length+' · '+remaining.size+' geometria(s) pendente(s)');
    const matches=await readRows(
      shard,
      ['geometryIndex','id','type','content'],
      {geometryIndex:{$in:[...remaining]}},
      {utf8:false}
    );
    for(const row of matches){
      const geometryIndex=Number(row.geometryIndex);
      if(!remaining.has(geometryIndex))continue;
      geometryRows.set(geometryIndex,{
        geometryIndex,
        id:decodeText(row.id),
        type:decodeText(row.type),
        content:asBytes(row.content)
      });
      remaining.delete(geometryIndex);
      if(geometryRows.size>=limit)break;
    }
    if(geometryRows.size>=limit)break;
  }

  progress(.94,geometryRows.size+' malha(s) SGEO encontrada(s)');

  const grouped=new Map();
  for(const [geometryIndex,row] of geometryRows){
    for(const target of byGeometry.get(geometryIndex)||[]){
      const list=grouped.get(target.objectIndex)||[];
      list.push({...row,transform:target.transform});
      grouped.set(target.objectIndex,list);
    }
  }

  let materialColors=new Map();
  if(includeMaterialColors){
    materialColors=await loadBundleMaterialColors(connection,indices);
  }

  const objects=indices
    .filter(index=>grouped.has(index))
    .map(index=>({
      objectIndex:index,
      displayColor:materialColors.get(index)||null,
      rows:grouped.get(index)
    }));

  progress(1,objects.length+' objeto(s) com geometria prontos para o RenderTree');

  return {
    objects,
    objectCount:objects.length,
    meshCount:[...grouped.values()].reduce((sum,rows)=>sum+rows.length,0),
    missingGeometryCount:remaining.size
  };
}