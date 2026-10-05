import { base44 } from '@/api/base44Client';

const FORMAT_VERSION='hyperview-render-v2';
const packMemory=new Map();
const buildInflight=new Map();

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function renderCacheKey(connection,geometryCache){
  return [
    String(connection?.project_id||''),
    String(connection?.model_id||''),
    String(connection?.version_id||''),
    String(geometryCache?.cache_key||''),
    FORMAT_VERSION
  ].join(':');
}

function parseMap(value){
  try{
    const parsed=JSON.parse(String(value||'[]'));
    return Array.isArray(parsed)?parsed:[];
  }catch{return []}
}

function backendMessage(error){
  return error?.response?.data?.error
    ||error?.response?.data?.message
    ||error?.data?.error
    ||error?.message
    ||'Falha no HyperView Render Cache.';
}

async function invokeRenderCache(action,connection){
  if(!connection?.id)throw new Error('Conexão Speckle não selecionada.');
  try{
    const response=await base44.functions.invoke('hyperViewRenderCacheApi',{
      action,
      connectionId:connection.id
    });
    const data=response?.data??response??{};
    if(data?.error)throw new Error(data.error);
    return data;
  }catch(error){
    throw new Error(backendMessage(error));
  }
}

async function fetchPrivateFile(fileUri,timeout=120000){
  const signed=await base44.integrations.Core.CreateFileSignedUrl({
    file_uri:String(fileUri||''),
    expires_in:3600
  });
  const response=await fetch(signed.signed_url,{signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('HyperView cache HTTP '+response.status);
  return new Uint8Array(await response.arrayBuffer());
}

export async function findReadyHyperViewRenderCache(connection,geometryCache){
  if(!connection?.version_id||!geometryCache?.cache_key)return null;
  const key=renderCacheKey(connection,geometryCache);
  const rows=await base44.entities.HyperViewRenderManifest.filter({
    render_cache_key:key,
    status:'ready',
    format_version:FORMAT_VERSION
  },'-updated_date',3);
  const manifest=rows?.[0];
  if(!manifest)return null;

  const packs=await base44.entities.HyperViewRenderPack.filter({
    render_cache_key:key,
    format_version:FORMAT_VERSION
  },'pack_index',500);
  const expected=Number(geometryCache.cached_chunks||geometryCache.total_chunks||geometryCache.chunks?.length||0);
  const packed=(packs||[]).reduce((sum,pack)=>sum+Number(pack.chunk_count||0),0);
  if(!packs?.length||packed<expected)return null;
  return {...manifest,packs};
}

export function attachHyperViewRenderCache(chunks,renderCache){
  if(!renderCache?.packs?.length)return [...(chunks||[])];
  const refs=new Map();
  for(const pack of renderCache.packs){
    for(const item of parseMap(pack.chunk_map_json)){
      refs.set(Number(item.chunkIndex),{
        renderCacheKey:String(renderCache.render_cache_key||''),
        renderPackIndex:Number(pack.pack_index||0),
        renderPackUri:String(pack.file_uri||''),
        renderPackOffset:Number(item.offset||0),
        renderPackLength:Number(item.length||0)
      });
    }
  }
  return (chunks||[]).map(descriptor=>({
    ...descriptor,
    ...(refs.get(Number(descriptor.chunkIndex))||{})
  }));
}

export async function readHyperViewPackedChunk(descriptor){
  const uri=String(descriptor?.renderPackUri||'');
  const length=Number(descriptor?.renderPackLength||0);
  if(!uri||length<=0)return null;

  const memoryKey=[
    descriptor?.renderCacheKey||'',
    descriptor?.renderPackIndex||0,
    uri
  ].join('|');

  let promise=packMemory.get(memoryKey);
  if(!promise){
    promise=fetchPrivateFile(uri);
    packMemory.set(memoryKey,promise);
    // Mantém poucos packs quentes. Com ~24 MB/pack isso evita duplicar
    // centenas de MB em RAM durante a residência completa.
    while(packMemory.size>3){
      const oldest=packMemory.keys().next().value;
      if(oldest===memoryKey)break;
      packMemory.delete(oldest);
    }
  }

  try{
    const bytes=await promise;
    const start=Number(descriptor.renderPackOffset||0);
    const end=start+length;
    if(start<0||end>bytes.byteLength||end<=start)return null;
    return bytes.subarray(start,end);
  }catch(error){
    packMemory.delete(memoryKey);
    throw error;
  }
}

export async function getHyperViewRenderCacheStatus(connection){
  return invokeRenderCache('status',connection);
}

export async function buildHyperViewRenderCache(connection,geometryCache,{onProgress}={}){
  if(!connection?.version_id||!geometryCache?.cache_key||!geometryCache?.chunks?.length){
    throw new Error('Cache PHD3D completo é obrigatório para gerar o HyperView Render Cache.');
  }

  const key=renderCacheKey(connection,geometryCache);
  const existing=await findReadyHyperViewRenderCache(connection,geometryCache);
  if(existing)return {...existing,reused:true};

  if(buildInflight.has(key))return buildInflight.get(key);

  const promise=(async()=>{
    let status=await invokeRenderCache('status',connection);
    onProgress?.({
      phase:'server',
      progress:Number(status?.totalChunks)
        ? Math.round((Number(status.packedChunks||0)/Number(status.totalChunks))*100)
        : 0,
      detail:Number(status?.packedChunks||0).toLocaleString('pt-BR')+
        ' / '+Number(status?.totalChunks||0).toLocaleString('pt-BR')+
        ' chunks já preparados no servidor'
    });

    for(let guard=0;guard<500&&!status?.ready;guard++){
      const step=await invokeRenderCache('buildNext',connection);
      status={
        ...status,
        ...step,
        ready:!!step?.done||String(step?.status||'')==='ready'
      };

      onProgress?.({
        phase:'server',
        progress:Number(step?.progress||(
          Number(step?.totalChunks)
            ? Math.round((Number(step.packedChunks||0)/Number(step.totalChunks))*100)
            : 0
        )),
        detail:Number(step?.packedChunks||0).toLocaleString('pt-BR')+
          ' / '+Number(step?.totalChunks||0).toLocaleString('pt-BR')+
          ' chunks · '+Number(step?.packCount||0).toLocaleString('pt-BR')+
          ' / '+Number(step?.totalPacks||0).toLocaleString('pt-BR')+
          ' packs HyperView'
      });

      if(status.ready)break;
      await wait(25);
    }

    const ready=await findReadyHyperViewRenderCache(connection,geometryCache);
    if(!ready)throw new Error('A geração do HyperView Render Cache não foi concluída.');
    return {...ready,reused:false};
  })().finally(()=>buildInflight.delete(key));

  buildInflight.set(key,promise);
  return promise;
}

export { FORMAT_VERSION as HYPERVIEW_RENDER_CACHE_VERSION };
