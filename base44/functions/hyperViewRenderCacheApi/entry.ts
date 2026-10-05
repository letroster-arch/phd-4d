import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';

const FORMAT_VERSION='hyperview-render-v2';
const BOOTSTRAP_PACK_BYTES=6*1024*1024;
const TARGET_PACK_BYTES=24*1024*1024;
const MAX_PACK_BYTES=32*1024*1024;
const DOWNLOAD_CONCURRENCY=8;

function json(data:any,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{'content-type':'application/json; charset=utf-8'}
  });
}

async function mapConcurrent(items:any[],limit:number,worker:(item:any,index:number)=>Promise<any>){
  const out=new Array(items.length);
  let cursor=0;
  const runners=Array.from({length:Math.max(1,Math.min(limit,items.length||1))},async()=>{
    while(true){
      const index=cursor++;
      if(index>=items.length)return;
      out[index]=await worker(items[index],index);
    }
  });
  await Promise.all(runners);
  return out;
}

function renderCacheKey(connection:any,geometryCache:any){
  return [
    String(connection?.project_id||''),
    String(connection?.model_id||''),
    String(connection?.version_id||''),
    String(geometryCache?.cache_key||''),
    FORMAT_VERSION
  ].join(':');
}

async function allRows(entity:any,query:any,sort:string,limit=500){
  const rows:any[]=[];
  for(let skip=0;skip<10000;skip+=limit){
    const page=await entity.filter(query,sort,limit,skip);
    rows.push(...(page||[]));
    if(!page||page.length<limit)break;
  }
  return rows;
}

function parseCenter(value:any){
  try{
    const parsed=JSON.parse(String(value||'null'));
    if(Array.isArray(parsed)&&parsed.length===3&&parsed.every(Number.isFinite))return parsed.map(Number);
  }catch{}
  return null;
}

function distributedBootstrap(chunks:any[],count=64){
  const source=[...(chunks||[])];
  if(source.length<=count)return source;

  const points=source
    .map(item=>({item,center:parseCenter(item.center_json)}))
    .filter(entry=>entry.center);
  if(points.length<Math.min(8,count))return source.slice(0,count);

  const xs=points.map(p=>p.center[0]),ys=points.map(p=>p.center[1]),zs=points.map(p=>p.center[2]);
  const min=[Math.min(...xs),Math.min(...ys),Math.min(...zs)];
  const max=[Math.max(...xs),Math.max(...ys),Math.max(...zs)];
  const span=max.map((value,index)=>Math.max(1,value-min[index]));
  const norm=center=>center.map((value,index)=>(value-min[index])/span[index]);
  const dist2=(a,b)=>{
    const dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];
    return dx*dx+dy*dy+dz*dz;
  };

  const normalized=points.map(entry=>({...entry,p:norm(entry.center)}));
  let seed=normalized[0],best=Infinity;
  for(const candidate of normalized){
    const d=dist2(candidate.p,[.5,.5,.5]);
    if(d<best){best=d;seed=candidate}
  }

  const selected=[seed];
  const selectedIds=new Set([Number(seed.item.chunk_index)]);
  const nearest=new Map(normalized.map(entry=>[
    Number(entry.item.chunk_index),
    dist2(entry.p,seed.p)
  ]));

  while(selected.length<count){
    let next=null,nextDistance=-1;
    for(const entry of normalized){
      const id=Number(entry.item.chunk_index);
      if(selectedIds.has(id))continue;
      const distance=nearest.get(id)??Infinity;
      // pequenos bônus por densidade para que estruturas/equipamentos
      // ganhem prioridade sobre tiles quase vazios.
      const density=1+Math.log2(Math.max(1,Number(entry.item.object_count||1)))/18;
      const score=distance*density;
      if(score>nextDistance){nextDistance=score;next=entry}
    }
    if(!next)break;
    selected.push(next);
    selectedIds.add(Number(next.item.chunk_index));
    for(const entry of normalized){
      const id=Number(entry.item.chunk_index);
      if(selectedIds.has(id))continue;
      nearest.set(id,Math.min(
        nearest.get(id)??Infinity,
        dist2(entry.p,next.p)
      ));
    }
  }

  return selected.map(entry=>entry.item);
}

function orderedForRenderCache(chunks:any[]){
  const source=[...(chunks||[])].sort((a,b)=>Number(a.chunk_index)-Number(b.chunk_index));
  if(source.length<=64)return source;
  const preview=source.filter(item=>String(item.role||'')==='preview'||Number(item.lod)===0);
  const rest=source.filter(item=>!preview.includes(item));
  const bootstrap=[...preview,...distributedBootstrap(rest,Math.max(0,64-preview.length))];
  const firstIds=new Set(bootstrap.map(item=>Number(item.chunk_index)));
  return [...bootstrap,...source.filter(item=>!firstIds.has(Number(item.chunk_index)))];
}

function splitIntoPacks(chunks:any[]){
  const groups:any[][]=[];
  let current:any[]=[],bytes=0;
  for(const descriptor of orderedForRenderCache(chunks)){
    const size=Math.max(1,Number(descriptor?.packed_bytes||0));
    const target=groups.length===0?BOOTSTRAP_PACK_BYTES:TARGET_PACK_BYTES;
    if(current.length&&(bytes+size>target||bytes>=Math.min(MAX_PACK_BYTES,target*1.25))){
      groups.push(current);current=[];bytes=0;
    }
    current.push(descriptor);bytes+=size;
  }
  if(current.length)groups.push(current);
  return groups;
}

async function fetchPrivate(base44:any,fileUri:string){
  const signed=await base44.integrations.Core.CreateFileSignedUrl({
    file_uri:String(fileUri||''),
    expires_in:3600
  });
  const response=await fetch(String(signed?.signed_url||''),{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('Chunk PHD3D HTTP '+response.status);
  return new Uint8Array(await response.arrayBuffer());
}

async function resolveConnection(base44:any,body:any){
  const id=String(body?.connectionId||'');
  if(!id)throw new Error('connectionId obrigatório.');
  const rows=await base44.entities.SpeckleConnection.filter({id},'-updated_date',1);
  const connection=rows?.[0];
  if(!connection)throw new Error('Conexão Speckle não encontrada.');
  return connection;
}

async function resolveGeometryCache(base44:any,connection:any){
  const rows=await base44.entities.GeometryCacheManifest.filter({
    project_id:String(connection.project_id||''),
    model_id:String(connection.model_id||''),
    version_id:String(connection.version_id||''),
    status:'ready'
  },'-updated_date',5);
  const manifest=rows?.[0];
  if(!manifest)throw new Error('PHD3D pronto não encontrado para esta versão.');
  const chunks=await allRows(
    base44.entities.GeometryCacheChunk,
    {cache_key:String(manifest.cache_key||'')},
    'chunk_index',
    500
  );
  if(!chunks.length)throw new Error('PHD3D sem chunks persistidos.');
  return {...manifest,chunks};
}

async function getRenderState(base44:any,connection:any,geometryCache:any){
  const key=renderCacheKey(connection,geometryCache);
  const manifests=await base44.entities.HyperViewRenderManifest.filter({render_cache_key:key},'-updated_date',5);
  const manifest=manifests?.[0]||null;
  const packs=manifest
    ? await allRows(base44.entities.HyperViewRenderPack,{render_cache_key:key},'pack_index',500)
    : [];
  return {key,manifest,packs};
}

export default async function(req:any){
  if(req.method!=='POST')return json({error:'Use POST.'});
  try{
    const base44=createClientFromRequest(req);
    const user=await base44.auth.me();
    if(!user)return json({error:'Autenticação necessária.'});

    const body=await req.json();
    const action=String(body?.action||'status');
    if(!['status','buildNext','reset'].includes(action))return json({error:'Operação inválida.'});

    const connection=await resolveConnection(base44,body);
    const geometryCache=await resolveGeometryCache(base44,connection);
    const groups=splitIntoPacks(geometryCache.chunks);
    const state=await getRenderState(base44,connection,geometryCache);

    if(action==='status'){
      const packedChunks=(state.packs||[]).reduce((sum:any,pack:any)=>sum+Number(pack.chunk_count||0),0);
      return json({
        ok:true,
        ready:state.manifest?.status==='ready'&&packedChunks>=geometryCache.chunks.length,
        status:state.manifest?.status||'missing',
        renderCacheKey:state.key,
        totalChunks:geometryCache.chunks.length,
        packedChunks,
        packCount:state.packs.length,
        totalBytes:(state.packs||[]).reduce((sum:any,pack:any)=>sum+Number(pack.packed_bytes||0),0),
        totalPacks:groups.length,
        format:FORMAT_VERSION
      });
    }

    if(String(user.role||'').toLowerCase()!=='admin'){
      return json({error:'Apenas administradores podem gerar o HyperView Render Cache.'});
    }

    if(action==='reset'){
      try{await base44.entities.HyperViewRenderPack.deleteMany({render_cache_key:state.key})}catch{}
      if(state.manifest){
        await base44.entities.HyperViewRenderManifest.update(state.manifest.id,{
          status:'building',
          format_version:FORMAT_VERSION,
          packed_chunks:0,
          pack_count:0,
          total_bytes:0,
          completed_at:'',
          error_message:''
        });
      }
      return json({ok:true,reset:true});
    }

    let manifest=state.manifest;
    const existing=[...(state.packs||[])].sort((a,b)=>Number(a.pack_index)-Number(b.pack_index));
    const contiguous=existing.every((pack,index)=>Number(pack.pack_index)===index);

    if(manifest&&(!contiguous||manifest.format_version!==FORMAT_VERSION)){
      try{await base44.entities.HyperViewRenderPack.deleteMany({render_cache_key:state.key})}catch{}
      manifest=null;
    }

    if(!manifest){
      manifest=await base44.entities.HyperViewRenderManifest.create({
        project_id:String(connection.project_id||''),
        model_id:String(connection.model_id||''),
        version_id:String(connection.version_id||''),
        geometry_cache_key:String(geometryCache.cache_key||''),
        render_cache_key:state.key,
        status:'building',
        format_version:FORMAT_VERSION,
        total_chunks:geometryCache.chunks.length,
        packed_chunks:0,
        pack_count:0,
        total_bytes:0,
        target_pack_bytes:TARGET_PACK_BYTES,
        source_geometry_format:String(geometryCache.format_version||''),
        completed_at:'',
        error_message:''
      });
    }

    const packs=manifest===state.manifest&&contiguous?existing:[];
    const nextPack=packs.length;
    if(nextPack>=groups.length){
      const packedChunks=packs.reduce((sum,pack)=>sum+Number(pack.chunk_count||0),0);
      const totalBytes=packs.reduce((sum,pack)=>sum+Number(pack.packed_bytes||0),0);
      await base44.entities.HyperViewRenderManifest.update(manifest.id,{
        status:'ready',
        packed_chunks:packedChunks,
        pack_count:packs.length,
        total_bytes:totalBytes,
        completed_at:new Date().toISOString(),
        error_message:''
      });
      return json({
        ok:true,done:true,status:'ready',
        totalChunks:geometryCache.chunks.length,
        packedChunks,
        packCount:packs.length,
        totalPacks:groups.length,
        totalBytes
      });
    }

    const group=groups[nextPack];
    const parts=await mapConcurrent(group,DOWNLOAD_CONCURRENCY,async descriptor=>({
      descriptor,
      bytes:await fetchPrivate(base44,String(descriptor.file_uri||''))
    }));

    const total=parts.reduce((sum,part)=>sum+part.bytes.byteLength,0);
    const merged=new Uint8Array(total);
    const map:any[]=[];
    let offset=0;
    for(const part of parts){
      merged.set(part.bytes,offset);
      map.push({
        chunkIndex:Number(part.descriptor.chunk_index),
        offset,
        length:part.bytes.byteLength
      });
      offset+=part.bytes.byteLength;
    }

    const file=new File(
      [merged],
      'hyperview-'+String(connection.version_id)+'-'+String(nextPack).padStart(3,'0')+'.hvrp',
      {type:'application/octet-stream'}
    );
    const uploaded=await base44.integrations.Core.UploadPrivateFile({file});
    if(!uploaded?.file_uri)throw new Error('Upload do Render Pack concluído sem file_uri.');

    const record=await base44.entities.HyperViewRenderPack.create({
      render_cache_key:state.key,
      manifest_id:String(manifest.id||''),
      project_id:String(connection.project_id||''),
      model_id:String(connection.model_id||''),
      version_id:String(connection.version_id||''),
      format_version:FORMAT_VERSION,
      pack_index:nextPack,
      file_uri:String(uploaded.file_uri),
      chunk_count:group.length,
      packed_bytes:merged.byteLength,
      chunk_map_json:JSON.stringify(map)
    });

    const allPacks=[...packs,record];
    const packedChunks=allPacks.reduce((sum,pack)=>sum+Number(pack.chunk_count||0),0);
    const totalBytes=allPacks.reduce((sum,pack)=>sum+Number(pack.packed_bytes||0),0);
    const done=allPacks.length>=groups.length;

    await base44.entities.HyperViewRenderManifest.update(manifest.id,{
      status:done?'ready':'building',
      total_chunks:geometryCache.chunks.length,
      packed_chunks:packedChunks,
      pack_count:allPacks.length,
      total_bytes:totalBytes,
      completed_at:done?new Date().toISOString():'',
      error_message:''
    });

    return json({
      ok:true,
      done,
      status:done?'ready':'building',
      packIndex:nextPack,
      packCount:allPacks.length,
      totalPacks:groups.length,
      packedChunks,
      totalChunks:geometryCache.chunks.length,
      totalBytes,
      progress:Math.round((packedChunks/Math.max(1,geometryCache.chunks.length))*100)
    });
  }catch(error:any){
    return json({error:error?.message||String(error)});
  }
}
