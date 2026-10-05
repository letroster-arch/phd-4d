import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, DatabaseZap, Loader2, RefreshCw, Rocket, TriangleAlert } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { bundleApi } from '@/components/speckle/bundleApi';
import { invalidateBundleGeometryCache, listRenderableObjectIndices, loadBundleGeometryBatch } from '@/components/twin/bundleBrowserGeometry';
import {
  beginGeometryCacheBuild,
  findReadyGeometryCache,
  loadGeometrySourceIndex,
  pruneGeometryCacheDuplicates,
  markGeometryCacheError,
  prepareGeometryCacheFiles,
  updateGeometryCacheManifest,
  uploadPreparedGeometryCacheFiles,
  PHD_GEOMETRY_CACHE_VERSION
} from '@/components/twin/geometryPersistentCache';
import { buildHyperViewRenderCache, findReadyHyperViewRenderCache } from '@/components/twin/hyperViewRenderCache';

const PREPARATION_BATCH_SIZE=4096;
const PREPARATION_RESUME_BATCH_SIZE=1024;
const PREPARATION_GEOMETRY_LIMIT=64000;

function distributedSample(indices,count=192){
  const source=[...(indices||[])];
  if(source.length<=count)return source;
  const result=[];
  const step=source.length/count;
  for(let i=0;i<count;i++)result.push(source[Math.min(source.length-1,Math.floor(i*step))]);
  return [...new Set(result)];
}

function fmtBytes(value){
  const bytes=Number(value||0);
  if(!bytes)return '0 MB';
  return (bytes/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:1})+' MB';
}

export default function ModelPreparation({connection,isAdmin}){
  const [state,setState]=useState({
    status:'checking',
    progress:0,
    detail:'Verificando cache…',
    total:0,
    cached:0,
    chunks:0,
    bytes:0,
    completedAt:'',
    error:''
  });
  const [renderState,setRenderState]=useState({
    status:'checking',
    progress:0,
    detail:'Verificando HyperView Render Cache…',
    packs:0,
    bytes:0,
    error:''
  });
  const runIdRef=useRef(0);
  const autoRenderBuildRef=useRef(new Set());
  const autoResumeRef=useRef(new Set());

  const refreshStatus=useCallback(async()=>{
    if(!connection?.id||!connection?.version_id){
      setState({
        status:'unconfigured',progress:0,detail:'Salve uma conexão e selecione uma versão antes de preparar o modelo.',
        total:0,cached:0,chunks:0,bytes:0,completedAt:'',error:''
      });
      setRenderState({
        status:'unconfigured',progress:0,detail:'HyperView aguardando uma versão válida.',
        packs:0,bytes:0,error:''
      });
      return;
    }
    setState(current=>({...current,status:'checking',detail:'Verificando modelo preparado…',error:''}));
    try{
      await pruneGeometryCacheDuplicates(connection);
      const ready=await findReadyGeometryCache(connection);
      if(ready){
        const total=Number(ready.total_objects||ready.cached_objects||0);
        const cached=Number(ready.cached_objects||0);
        const missing=Math.max(0,total-cached);
        const coverage=total?Math.min(100,(cached/total)*100):100;
        setState({
          status:'ready',
          progress:Math.round(coverage*10)/10,
          detail:missing>0
            ? 'Cache PHD3D concluído, porém '+missing.toLocaleString('pt-BR')+
              ' índice(s) renderizável(is) não geraram geometria no cache.'
            : ready.ingest_detail||'Modelo preparado integralmente e disponível para o Digital Twin.',
          total,
          cached,
          missing,
          coverage,
          chunks:Number(ready.cached_chunks||ready.total_chunks||ready.chunks?.length||0),
          bytes:Number(ready.total_bytes||0),
          completedAt:ready.completed_at||'',
          serverSide:!!ready.server_side,
          phase:ready.ingest_phase||'packing',
          error:''
        });

        const renderReady=await findReadyHyperViewRenderCache(connection,ready);
        if(renderReady){
          setRenderState({
            status:'ready',
            progress:100,
            detail:'HyperView Render Cache pronto. O Viewer abrirá por packs pré-agrupados.',
            packs:Number(renderReady.pack_count||renderReady.packs?.length||0),
            bytes:Number(renderReady.total_bytes||0),
            error:''
          });
        }else{
          const renderRows=await base44.entities.HyperViewRenderManifest.filter({
            project_id:String(connection.project_id||''),
            model_id:String(connection.model_id||''),
            version_id:String(connection.version_id||'')
          },'-updated_date',3);
          const latestRender=renderRows?.[0];
          if(latestRender&&['building','partial','error'].includes(String(latestRender.status||''))){
            const totalChunks=Math.max(1,Number(latestRender.total_chunks||ready.cached_chunks||1));
            const packedChunks=Number(latestRender.packed_chunks||0);
            setRenderState({
              status:latestRender.status==='building'?'partial':latestRender.status,
              progress:Math.min(99,Math.round((packedChunks/totalChunks)*100)),
              detail:latestRender.status==='error'
                ? 'A geração anterior do HyperView Render Cache falhou.'
                : packedChunks.toLocaleString('pt-BR')+' / '+totalChunks.toLocaleString('pt-BR')+
                  ' chunks já agrupados. A geração pode ser retomada.',
              packs:Number(latestRender.pack_count||0),
              bytes:Number(latestRender.total_bytes||0),
              error:latestRender.error_message||''
            });
          }else{
            setRenderState({
              status:'missing',
              progress:0,
              detail:'PHD3D pronto. Falta gerar o HyperView Render Cache para abertura acelerada.',
              packs:0,bytes:0,error:''
            });
          }
        }
        return;
      }
      const rows=await base44.entities.GeometryCacheManifest.filter({
        project_id:String(connection.project_id||''),
        model_id:String(connection.model_id||''),
        version_id:String(connection.version_id||'')
      },'-updated_date',5);
      const latest=rows?.[0];
      if(latest&&latest.format_version!==PHD_GEOMETRY_CACHE_VERSION){
        setState({
          status:'pending',progress:0,
          detail:'Cache antigo detectado ('+(latest.format_version||'sem versão')+'). Prepare novamente para gerar PHD3D Spatial v3.',
          total:Number(latest.total_objects||0),cached:0,chunks:0,bytes:0,completedAt:'',error:''
        });
        return;
      }
      if(latest){
        const total=Number(latest.total_objects||0);
        const cached=Number(latest.cached_objects||0);
        const manifestPhase=String(latest.ingest_phase||'').toLowerCase();
        const browserResume=manifestPhase.startsWith('viewer-ready-browser')||
          String(latest.source||'').toLowerCase().includes('browser');
        const serverSide=browserResume?false:!!latest.server_side;
        const serverProgress=Number(latest.ingest_progress||0);
        const coverage=total?Math.min(100,(cached/total)*100):0;
        setState({
          status:latest.status==='error'?'error':['building','partial'].includes(latest.status)?'partial':'pending',
          progress:browserResume
            ? Math.min(99,Math.round(coverage*10)/10)
            : serverSide&&serverProgress>0
              ? Math.min(99,serverProgress)
              : total?Math.min(99,Math.round(coverage*10)/10):0,
          detail:latest.ingest_detail
            ? String(latest.ingest_detail)
            : ['building','partial'].includes(latest.status)
              ? 'Checkpoint encontrado no lote '+Number(latest.next_batch_index||0)+' de '+Number(latest.total_batches||0)+'. Clique em Retomar preparação.'
              : latest.status==='error'
                ? 'A última preparação falhou antes de criar um checkpoint recuperável.'
                : 'Esta versão ainda não foi preparada.',
          total,
          cached,
          coverage,
          chunks:Number(latest.cached_chunks||0),
          bytes:Number(latest.total_bytes||0),
          completedAt:latest.completed_at||'',
          serverSide,
          phase:latest.ingest_phase||'',
          error:latest.error_message||''
        });
        return;
      }
      setState({
        status:'pending',progress:0,detail:'Esta versão ainda não foi preparada.',
        total:0,cached:0,chunks:0,bytes:0,completedAt:'',error:''
      });
      setRenderState({
        status:'missing',progress:0,detail:'Prepare o PHD3D antes do HyperView Render Cache.',
        packs:0,bytes:0,error:''
      });
    }catch(error){
      setState(current=>({...current,status:'error',detail:'Não foi possível consultar o cache PHD.',error:error?.message||String(error)}));
      setRenderState(current=>({...current,status:'error',detail:'Não foi possível consultar o HyperView Render Cache.',error:error?.message||String(error)}));
    }
  },[connection?.id,connection?.project_id,connection?.model_id,connection?.version_id]);

  const buildRenderCache=useCallback(async()=>{
    if(!connection?.id||!connection?.version_id)return;
    setRenderState(current=>({
      ...current,
      status:'building',
      progress:Math.max(1,Number(current.progress||0)),
      detail:'Gerando HyperView Render Cache para o modelo inteiro…',
      error:''
    }));

    try{
      const geometryCache=await findReadyGeometryCache(connection);
      if(!geometryCache?.chunks?.length){
        throw new Error('O PHD3D precisa estar pronto antes do HyperView Render Cache.');
      }

      const renderCache=await buildHyperViewRenderCache(connection,geometryCache,{
        onProgress:info=>{
          setRenderState(current=>({
            ...current,
            status:'building',
            progress:Math.max(1,Math.min(99,Number(info?.progress||0))),
            detail:info?.detail||'Gerando packs de renderização…',
            error:''
          }));
        }
      });

      setRenderState({
        status:'ready',
        progress:100,
        detail:'HyperView Render Cache pronto. A abertura agora usa packs pré-agrupados do modelo inteiro.',
        packs:Number(renderCache?.pack_count||renderCache?.packs?.length||0),
        bytes:Number(renderCache?.total_bytes||0),
        error:''
      });
    }catch(error){
      setRenderState(current=>({
        ...current,
        status:'error',
        detail:'Falha ao gerar HyperView Render Cache.',
        error:error?.message||String(error)
      }));
    }
  },[connection?.id,connection?.project_id,connection?.model_id,connection?.version_id]);

  useEffect(()=>{
    runIdRef.current+=1;
    void refreshStatus();
    return()=>{runIdRef.current+=1};
  },[refreshStatus]);

  useEffect(()=>{
    if(!isAdmin||state.status!=='ready')return;
    if(!['missing','partial','error'].includes(String(renderState.status||'')))return;
    const key=[
      connection?.project_id||'',
      connection?.model_id||'',
      connection?.version_id||''
    ].join(':');
    if(!key||autoRenderBuildRef.current.has(key))return;
    autoRenderBuildRef.current.add(key);
    void buildRenderCache();
  },[
    isAdmin,
    state.status,
    renderState.status,
    connection?.project_id,
    connection?.model_id,
    connection?.version_id,
    buildRenderCache
  ]);

  const applyServerIngestionState=useCallback(info=>{
    const total=Number(info?.totalObjects||0);
    const cached=Number(info?.cachedObjects||0);
    const done=!!info?.done||String(info?.status||'')==='ready';
    const status=done
      ? 'ready'
      : String(info?.status||'')==='error'
        ? 'error'
        : String(info?.status||'')==='partial'
          ? 'partial'
          : 'building';
    const progress=done
      ? 100
      : Math.max(1,Math.min(99,Number(info?.progress||0)));
    setState(current=>({
      ...current,
      status,
      progress,
      detail:String(info?.detail||'Processando modelo no backend…'),
      total:total||current.total||0,
      cached:Number.isFinite(cached)?cached:Number(current.cached||0),
      coverage:total?Math.min(100,(cached/total)*100):Number(current.coverage||0),
      chunks:Number(info?.chunks??current.chunks??0),
      bytes:Number(info?.totalBytes??current.bytes??0),
      serverSide:true,
      phase:String(info?.phase||''),
      error:status==='error'?String(info?.error||current.error||'Falha na ingestão server-side.'):''
    }));
  },[]);

  const prepareServer=async()=>{
    if(!connection?.id||!connection?.version_id||!isAdmin)return;

    const runId=++runIdRef.current;
    const cancelled=()=>runId!==runIdRef.current;
    const force=state.status==='ready'&&renderState.status==='ready';

    try{
      setState(current=>({
        ...current,
        status:'building',
        progress:1,
        detail:'Enfileirando ingestão PHD3D no backend…',
        serverSide:true,
        phase:'queued',
        error:''
      }));

      const info=await bundleApi('ingestStart',connection,{force});
      if(cancelled())return;
      applyServerIngestionState(info);

      if(String(info?.status||'')==='error'){
        throw new Error(info?.detail||'Falha na ingestão PHD3D server-side.');
      }

      // A conversão continua no backend. A tela passa apenas a acompanhar
      // o manifesto; fechar ou recarregar o navegador não interrompe o job.
      if(info?.done||String(info?.status||'')==='ready'){
        await refreshStatus();
      }
    }catch(error){
      if(cancelled())return;
      const message=error?.message||String(error);
      let latest=null;
      try{latest=await bundleApi('ingestStatus',connection,{})}catch{}
      if(latest)applyServerIngestionState(latest);
      setState(current=>({
        ...current,
        status:Number(current.cached||0)>0?'partial':'error',
        detail:Number(current.cached||0)>0
          ? 'Ingestão pausada no servidor. O checkpoint foi preservado para retomada.'
          : 'Falha ao iniciar a ingestão PHD3D no backend.',
        serverSide:true,
        error:message
      }));
    }
  };

  useEffect(()=>{
    const phase=String(state.phase||'').toLowerCase();
    if(
      !connection?.id||
      !state.serverSide||
      phase.startsWith('viewer-ready')||
      !['building','partial'].includes(String(state.status||''))
    )return;
    let disposed=false;
    let timer=null;

    const poll=async()=>{
      try{
        const info=await bundleApi('ingestStatus',connection,{});
        if(disposed)return;
        applyServerIngestionState(info);
        if(info?.done||String(info?.status||'')==='ready'){
          await refreshStatus();
          return;
        }
      }catch{}
      if(!disposed)timer=setTimeout(poll,1500);
    };

    timer=setTimeout(poll,900);
    return()=>{
      disposed=true;
      if(timer)clearTimeout(timer);
    };
  },[
    connection?.id,
    connection?.project_id,
    connection?.model_id,
    connection?.version_id,
    state.serverSide,
    state.status,
    state.phase,
    applyServerIngestionState,
    refreshStatus
  ]);

  const prepare=async()=>{
    if(!connection?.id||!connection?.version_id)return;

    const runId=++runIdRef.current;
    const identity=[
      connection?.app_project_id||'',
      connection?.project_id||'',
      connection?.model_id||'',
      connection?.version_id||''
    ].join(':');
    const cancelled=()=>runId!==runIdRef.current;

    let manifest=null;
    let descriptors=[];
    let cachedObjects=0;
    let chunkIndex=0;
    let uploadFailures=0;

    try{
      setState(current=>({
        ...current,
        status:'building',
        progress:Math.max(1,Number(current.progress||1)),
        detail:'Localizando o último checkpoint PHD3D…',
        serverSide:false,
        phase:Number(current.cached||0)>0?'viewer-ready-browser':'browser-preparation',
        error:''
      }));

      let batchSize=PREPARATION_BATCH_SIZE;
      const currentRows=await base44.entities.GeometryCacheManifest.filter({
        project_id:String(connection.project_id||''),
        model_id:String(connection.model_id||''),
        version_id:String(connection.version_id||''),
        format_version:PHD_GEOMETRY_CACHE_VERSION
      },'-updated_date',5);
      const currentManifest=currentRows?.[0]||null;
      const canUseSavedIndex=!!(
        currentManifest?.source_index_uri&&
        ['building','partial','error'].includes(String(currentManifest.status||''))&&
        Number(currentManifest.cached_chunks||0)>0&&
        Number(currentManifest.next_object_offset||0)>0
      );

      let renderable=[];
      let previewIndices=[];
      let pending=[];
      let totalRenderableObjects=Number(currentManifest?.total_objects||0);
      let usedSavedIndex=false;

      if(canUseSavedIndex){
        setState(current=>({
          ...current,
          detail:'Carregando índice PHD3D salvo · retomada direta sem remapear o Bundle…'
        }));
        try{
          pending=await loadGeometrySourceIndex(currentManifest);
          const savedOffset=Number(currentManifest.next_object_offset||0);
          if(!pending.length||savedOffset>pending.length){
            throw new Error('Índice salvo incompatível com o checkpoint atual.');
          }
          usedSavedIndex=true;
          batchSize=PREPARATION_RESUME_BATCH_SIZE;
        }catch{
          pending=[];
          usedSavedIndex=false;
        }
      }

      if(!usedSavedIndex){
        setState(current=>({
          ...current,
          detail:'Mapeando todos os objetos renderizáveis…'
        }));
        renderable=await listRenderableObjectIndices(connection,{
          limit:1000000,
          onProgress:(value,detail)=>{
            if(cancelled())return;
            setState(current=>({
              ...current,
              status:'building',
              progress:Math.max(1,Math.min(8,Math.round(value*8))),
              detail
            }));
          }
        });

        if(cancelled())return;
        if(!renderable.length)throw new Error('Nenhum objeto renderizável foi localizado nesta versão.');

        totalRenderableObjects=renderable.length;
        previewIndices=distributedSample(renderable,192);
        const previewSet=new Set(previewIndices);
        pending=renderable.filter(index=>!previewSet.has(index));
      }

      const totalBatches=Math.ceil(pending.length/batchSize);

      manifest=await beginGeometryCacheBuild(
        connection,
        totalRenderableObjects,
        {totalBatches,batchSize,resume:true}
      );

      if(cancelled())return;

      descriptors=[...(manifest.chunks||[])];
      cachedObjects=Number(manifest.cached_objects||0);
      uploadFailures=Number(manifest.upload_failures||0);
      chunkIndex=descriptors.length
        ? Math.max(...descriptors.map(item=>Number(item.chunkIndex)||0))+1
        : 0;

      if(!manifest.resumed&&usedSavedIndex){
        throw new Error('O índice salvo existe, mas o checkpoint não pôde ser retomado com segurança.');
      }

      if(!manifest.resumed){
        setState(current=>({
          ...current,
          status:'building',
          progress:6,
          detail:'Criando preview global LOD 0…',
          total:totalRenderableObjects,
          cached:cachedObjects,
          chunks:descriptors.length
        }));

        const previewGeometry=await loadBundleGeometryBatch(connection,previewIndices,{
          limit:12000,
          includeMaterialColors:true,
          onProgress:(value,detail)=>{
            if(cancelled())return;
            setState(current=>({...current,progress:6+Math.round(value*2),detail:'Preview global · '+detail}));
          }
        });
        if(cancelled())return;

        const previewObjects=(previewGeometry.objects||[]).map(object=>({
          ...object,
          applicationId:String(object.objectIndex)
        }));

        if(previewObjects.length){
          const preparedPreview=await prepareGeometryCacheFiles(
            connection,
            previewObjects,
            chunkIndex,
            {role:'preview',lod:0,spatial:false}
          );
          chunkIndex+=preparedPreview.length;
          const uploadedPreview=await uploadPreparedGeometryCacheFiles(preparedPreview,{
            onRetry:({chunkIndex:retryChunk,attempt,maxAttempts,delayMs,error})=>{
              uploadFailures+=1;
              if(cancelled())return;
              setState(current=>({
                ...current,
                detail:'Preview · falha de rede no chunk '+retryChunk+' · tentativa '+attempt+'/'+maxAttempts+
                  (delayMs?' · nova tentativa em '+Math.round(delayMs/1000)+'s':'')+
                  ' · '+(error?.message||'Failed to fetch')
              }));
            }
          });
          descriptors.push(...uploadedPreview);
          cachedObjects+=uploadedPreview.reduce((sum,item)=>sum+Number(item.objectCount||0),0);
          manifest=await updateGeometryCacheManifest(
            manifest,
            descriptors,
            cachedObjects,
            'building',
            '',
            {nextBatchIndex:0,totalBatches,nextObjectOffset:0,preparationBatchSize:batchSize,uploadFailures}
          );
        }
      }

      const startOffset=Math.min(
        pending.length,
        manifest.resumed?Number(manifest.resumeObjectOffset||0):0
      );
      const startBatch=Math.floor(startOffset/batchSize);

      if(startOffset>0){
        const pct=Math.min(96,Math.round((cachedObjects/Math.max(1,totalRenderableObjects))*100));
        setState(current=>({
          ...current,
          status:'building',
          progress:pct,
          detail:'Retomando em '+startOffset.toLocaleString('pt-BR')+
            ' / '+pending.length.toLocaleString('pt-BR')+
            ' objetos · novo pipeline '+batchSize.toLocaleString('pt-BR')+' objetos/lote',
          total:totalRenderableObjects,
          cached:cachedObjects,
          chunks:descriptors.length,
          bytes:descriptors.reduce((sum,item)=>sum+Number(item.packedBytes||0),0),
          error:''
        }));
      }

      const loadGeometryAt=(offset,batchNumber)=>{
        const indices=pending.slice(offset,Math.min(pending.length,offset+batchSize));
        if(!indices.length)return null;

        return (async()=>{
          let lastError=null;
          const delays=[0,2000,5000,10000];
          for(let attempt=0;attempt<delays.length;attempt++){
            if(cancelled())return null;
            if(delays[attempt])await new Promise(resolve=>setTimeout(resolve,delays[attempt]));

            try{
              return await loadBundleGeometryBatch(connection,indices,{
                limit:PREPARATION_GEOMETRY_LIMIT,
                maxObjects:batchSize,
                includeMaterialColors:true,
                onProgress:(value,detail)=>{
                  if(cancelled())return;
                  const processed=Math.min(pending.length,offset+Math.round(indices.length*value));
                  const pct=8+Math.round((processed/Math.max(pending.length,1))*82);
                  setState(current=>({
                    ...current,
                    status:'building',
                    progress:Math.min(92,pct),
                    detail:'Lote '+(batchNumber+1)+' de '+totalBatches+
                      ' · '+indices.length.toLocaleString('pt-BR')+' objetos · '+detail,
                    total:totalRenderableObjects,
                    cached:cachedObjects,
                    chunks:descriptors.length,
                    error:''
                  }));
                }
              });
            }catch(error){
              lastError=error;
              if(attempt===delays.length-1)break;
              invalidateBundleGeometryCache(connection);
              setState(current=>({
                ...current,
                status:'building',
                detail:'Oscilação de rede no lote '+(batchNumber+1)+'/'+totalBatches+
                  ' · tentativa '+(attempt+2)+'/'+delays.length+
                  ' em '+Math.round(delays[attempt+1]/1000)+'s · renovando URLs do Bundle',
                error:''
              }));
            }
          }
          throw lastError||new Error('Falha de rede ao ler o lote do Bundle.');
        })();
      };

      let currentOffset=startOffset;
      let currentBatch=startBatch;
      let geometryPromise=currentOffset<pending.length
        ? loadGeometryAt(currentOffset,currentBatch)
        : null;

      while(geometryPromise){
        if(cancelled())return;

        const currentIdentity=[
          connection?.app_project_id||'',
          connection?.project_id||'',
          connection?.model_id||'',
          connection?.version_id||''
        ].join(':');
        if(currentIdentity!==identity)return;

        const offsetForBatch=currentOffset;
        const batchNumber=currentBatch;
        const geometry=await geometryPromise;
        if(cancelled())return;

        const nextOffset=Math.min(pending.length,offsetForBatch+batchSize);
        const nextBatch=batchNumber+1;

        // Prefetch: enquanto este lote é convertido/comprimido/enviado,
        // o próximo já inicia a leitura de Relations/SGEO.
        geometryPromise=nextOffset<pending.length
          ? loadGeometryAt(nextOffset,nextBatch)
          : null;

        const objects=(geometry.objects||[]).map(object=>({
          ...object,
          applicationId:String(object.objectIndex)
        }));

        if(objects.length){
          setState(current=>({
            ...current,
            status:'building',
            detail:'Lote '+(batchNumber+1)+' de '+totalBatches+
              ' · convertendo '+objects.length.toLocaleString('pt-BR')+
              ' objetos para PHD3D GPU-ready · próximo lote em pré-leitura'
          }));

          const prepared=await prepareGeometryCacheFiles(
            connection,
            objects,
            chunkIndex,
            {role:'detail',lod:2,spatial:true}
          );
          chunkIndex+=prepared.length;

          const uploaded=await uploadPreparedGeometryCacheFiles(prepared,{
            concurrency:6,
            onRetry:({chunkIndex:retryChunk,attempt,maxAttempts,delayMs,error})=>{
              uploadFailures+=1;
              if(cancelled())return;
              setState(current=>({
                ...current,
                status:'building',
                detail:'Falha de rede no chunk '+retryChunk+
                  ' · tentativa '+attempt+'/'+maxAttempts+
                  (delayMs?' · nova tentativa em '+Math.round(delayMs/1000)+'s':'')+
                  ' · '+(error?.message||'Failed to fetch'),
                error:''
              }));
            }
          });

          if(cancelled())return;

          descriptors.push(...uploaded);
          cachedObjects+=uploaded.reduce((sum,item)=>sum+Number(item.objectCount||0),0);
        }

        manifest=await updateGeometryCacheManifest(
          manifest,
          descriptors,
          cachedObjects,
          'building',
          '',
          {
            nextBatchIndex:nextBatch,
            totalBatches,
            nextObjectOffset:nextOffset,
            preparationBatchSize:batchSize,
            uploadFailures
          }
        );

        if(cancelled())return;

        const pct=Math.min(96,Math.round((nextOffset/Math.max(pending.length,1))*100));
        setState(current=>({
          ...current,
          status:'building',
          progress:pct,
          detail:cachedObjects.toLocaleString('pt-BR')+
            ' objetos preparados · '+nextOffset.toLocaleString('pt-BR')+
            ' / '+pending.length.toLocaleString('pt-BR')+
            ' indexados · lote '+(batchNumber+1)+'/'+totalBatches,
          total:totalRenderableObjects,
          cached:cachedObjects,
          chunks:descriptors.length,
          bytes:descriptors.reduce((sum,item)=>sum+Number(item.packedBytes||0),0),
          error:''
        }));

        currentOffset=nextOffset;
        currentBatch=nextBatch;
      }

      if(cancelled())return;
      if(!cachedObjects)throw new Error('Nenhuma geometria válida foi preparada.');

      manifest=await updateGeometryCacheManifest(
        manifest,
        descriptors,
        cachedObjects,
        'ready',
        '',
        {
          nextBatchIndex:totalBatches,
          totalBatches,
          nextObjectOffset:pending.length,
          preparationBatchSize:batchSize,
          uploadFailures
        }
      );

      if(cancelled())return;

      await base44.entities.SpeckleConnection.update(connection.id,{
        status:'ready',
        last_sync_at:new Date().toISOString()
      });

      setState({
        status:'ready',
        progress:100,
        detail:'Modelo preparado. O Digital Twin agora carrega somente o cache PHD.',
        total:cachedObjects,
        cached:cachedObjects,
        chunks:descriptors.length,
        bytes:descriptors.reduce((sum,item)=>sum+Number(item.packedBytes||0),0),
        completedAt:new Date().toISOString(),
        error:''
      });
    }catch(error){
      if(cancelled())return;

      if(manifest){
        try{
          manifest=await updateGeometryCacheManifest(
            manifest,
            descriptors,
            cachedObjects,
            cachedObjects>0||descriptors.length?'partial':'error',
            error?.message||String(error),
            {
              nextBatchIndex:Number(manifest.next_batch_index||0),
              totalBatches:Number(manifest.total_batches||0),
              nextObjectOffset:Number(manifest.next_object_offset||0),
              preparationBatchSize:Number(manifest.preparation_batch_size||batchSize||0),
              uploadFailures
            }
          );
        }catch{
          await markGeometryCacheError(manifest,error);
        }
      }

      const resumable=(
        Number(manifest?.cached_chunks||0)>0||descriptors.length>0
      );

      setState(current=>({
        ...current,
        status:resumable?'partial':'error',
        detail:resumable
          ? 'Preparação pausada. O checkpoint foi salvo e pode ser retomado.'
          : 'Falha durante a preparação do modelo.',
        cached:cachedObjects||Number(manifest?.cached_objects||current.cached||0),
        chunks:descriptors.length||Number(manifest?.cached_chunks||current.chunks||0),
        bytes:descriptors.length
          ? descriptors.reduce((sum,item)=>sum+Number(item.packedBytes||0),0)
          : Number(manifest?.total_bytes||current.bytes||0),
        error:error?.message||String(error)
      }));
    }
  };

  useEffect(()=>{
    if(!isAdmin||!connection?.id||!connection?.version_id)return;
    if(state.status!=='partial'||Number(state.cached||0)<=0)return;

    const phase=String(state.phase||'').toLowerCase();
    const browserCheckpoint=!state.serverSide||phase.startsWith('viewer-ready');
    if(!browserCheckpoint)return;

    const key=[
      connection.id,
      connection.version_id,
      Number(state.cached||0),
      Number(state.chunks||0)
    ].join(':');
    if(autoResumeRef.current.has(key))return;

    autoResumeRef.current.add(key);
    void prepare();
  },[
    isAdmin,
    connection?.id,
    connection?.version_id,
    state.status,
    state.cached,
    state.chunks,
    state.serverSide,
    state.phase
  ]);

  const building=state.status==='building';
  const ready=state.status==='ready';
  const partial=state.status==='partial';
  const renderBuilding=renderState.status==='building';
  const renderReady=renderState.status==='ready';
  const geometryMissing=Number(state.missing||0);
  const ingestionPhase=String(state.phase||'').toLowerCase();
  const viewerReadyPartial=partial&&Number(state.cached||0)>0&&(
    ingestionPhase.startsWith('viewer-ready')||!state.serverSide
  );
  const finalReady=ready&&renderReady&&geometryMissing===0;
  const geometryProgress=Math.max(0,Math.min(100,Number(state.progress||0)));
  const cacheCoverage=Number(state.total||0)
    ? Math.min(100,(Number(state.cached||0)/Number(state.total||1))*100)
    : Number(state.coverage??geometryProgress??0);
  const renderProgress=Math.max(0,Math.min(100,Number(renderState.progress||0)));
  const unifiedProgress=finalReady
    ? 100
    : viewerReadyPartial
      ? cacheCoverage
      : ready
        ? Math.min(99,90+(renderProgress*0.09))
        : Math.min(89,geometryProgress);
  const activeStageIndex=finalReady
    ? 4
    : viewerReadyPartial
      ? 4
      : ready||renderBuilding
        ? 3
        : ingestionPhase==='converting'||ingestionPhase==='packing'
          ? 2
          : ingestionPhase==='reading'||ingestionPhase==='queued'
            ? 0
            : geometryProgress<8
              ? 0
              : geometryProgress<90
                ? 1
                : 2;
  const pipelineStages=['Sincronizando','Preparando','Convertendo','Publicando','Pronto'];
  const modelTitle=connection?.model_name||connection?.name||'Modelo 3D';
  const projectTitle=connection?.project_name||connection?.project_id||'Speckle';
  const paused=(partial&&!viewerReadyPartial)||renderState.status==='partial';
  const hasError=state.status==='error'||renderState.status==='error';
  const statusLabel=finalReady
    ? 'Modelo pronto para visualização'
    : viewerReadyPartial
      ? 'Viewer liberado · cache parcial utilizável'
      : renderReady&&geometryMissing>0
        ? 'Modelo publicado com cobertura parcial'
        : hasError
          ? ready?'Falha na publicação':'Falha na preparação'
          : paused
            ? ready?'Publicação pausada · checkpoint salvo':'Preparação pausada · checkpoint salvo'
            : renderBuilding
              ? 'Publicando modelo'
              : ready
                ? 'Preparando publicação'
                : building
                  ? activeStageIndex===0?'Sincronizando modelo':activeStageIndex===1?'Preparando modelo':'Convertendo modelo'
                  : state.status==='checking'
                    ? 'Verificando modelo'
                    : 'Modelo ainda não preparado';
  const statusDetail=ready&&!renderReady
    ? renderState.detail
    : state.detail;
  const primaryPublishes=ready&&!renderReady;
  const primaryDisabled=building||renderBuilding||!isAdmin||!connection?.id||!connection?.version_id||renderState.status==='checking';
  const primaryLabel=building
    ? 'Preparando…'
    : renderBuilding
      ? 'Publicando…'
      : finalReady
        ? 'Preparar novamente'
        : viewerReadyPartial
          ? 'Continuar otimização'
          : primaryPublishes
            ? renderState.status==='error'||renderState.status==='partial'?'Retomar publicação':'Publicar modelo'
            : partial
              ? 'Retomar preparação'
              : 'Sincronizar e preparar modelo';

  return <section className={'settings-card model-preparation-card speckle-prep '+(finalReady?'is-ready':viewerReadyPartial?'is-viewer-ready':paused?'is-paused':hasError?'is-error':'')}>
    <header>
      <DatabaseZap size={16}/>
      <h2>PREPARAÇÃO DO MODELO 3D</h2>
      <span className="ml-auto muted">02 / INGESTÃO + PHD3D + HYPERVIEW</span>
    </header>

    <div className="model-preparation-body speckle-prep-body">
      <div className="speckle-prep-hero">
        <span className={'speckle-prep-icon '+(finalReady||viewerReadyPartial?'ready':hasError?'error':paused?'paused':'running')}>
          {finalReady||viewerReadyPartial
            ? <CheckCircle2 size={24}/>
            : hasError
              ? <TriangleAlert size={24}/>
              : building||renderBuilding
                ? <Loader2 size={24} className="animate-spin"/>
                : <DatabaseZap size={24}/>}
        </span>

        <div className="speckle-prep-copy">
          <small>{projectTitle}</small>
          <strong title={modelTitle}>{modelTitle}</strong>
          <p>{statusLabel}</p>
          <span>{statusDetail}</span>
        </div>

        <div className="speckle-prep-percent">
          <b>{Number(unifiedProgress).toLocaleString('pt-BR',{maximumFractionDigits:1})}%</b>
          <small>{finalReady?'READY':viewerReadyPartial?'VIEWER READY':paused?'PAUSADO':hasError?'ATENÇÃO':'PROCESSANDO'}</small>
        </div>
      </div>

      <div className="speckle-prep-track" aria-label={'Preparação do modelo '+unifiedProgress+'%'}>
        <i style={{width:unifiedProgress+'%'}}/>
      </div>

      <div className="speckle-prep-stages">
        {pipelineStages.map((label,index)=>{
          const done=index<activeStageIndex||finalReady;
          const active=index===activeStageIndex&&!finalReady;
          return <span key={label} className={(done?'done ':'')+(active?'active ':'')+(hasError&&active?'error':'')}>
            <i>{done?'✓':index+1}</i>
            <b>{label}</b>
          </span>;
        })}
      </div>

      <div className="speckle-prep-summary">
        <span><small>OBJETOS</small><b>{Number(state.cached||0).toLocaleString('pt-BR')}{state.total?' / '+Number(state.total).toLocaleString('pt-BR'):''}</b></span>
        <span><small>COBERTURA</small><b>{Number(state.coverage??state.progress??0).toLocaleString('pt-BR',{maximumFractionDigits:1})}%</b></span>
        <span><small>ABERTURA</small><b>{viewerReadyPartial?'Streaming Bundle':renderReady?'HyperView pronta':renderBuilding?renderProgress.toLocaleString('pt-BR',{maximumFractionDigits:0})+'%':'Pendente'}</b></span>
      </div>

      {(state.error||renderState.error)&&<div className="inline-error">{state.error||renderState.error}</div>}

      <details className="speckle-prep-details">
        <summary>Detalhes técnicos</summary>
        <div className="speckle-prep-details-grid">
          <span><small>OBJETOS 3D PREPARADOS</small><b>{Number(state.cached||0).toLocaleString('pt-BR')}{state.total?' / '+Number(state.total).toLocaleString('pt-BR'):''}</b></span>
          <span><small>COBERTURA GEOMÉTRICA</small><b>{Number(state.coverage??state.progress??0).toLocaleString('pt-BR',{maximumFractionDigits:1})}%{geometryMissing>0?' · -'+geometryMissing.toLocaleString('pt-BR'):''}</b></span>
          <span><small>CHUNKS PHD3D</small><b>{Number(state.chunks||0).toLocaleString('pt-BR')}</b></span>
          <span><small>STORAGE PHD3D</small><b>{fmtBytes(state.bytes)}</b></span>
          <span><small>PACKS DE RENDER</small><b>{Number(renderState.packs||0).toLocaleString('pt-BR')}</b></span>
          <span><small>STORAGE HYPERVIEW</small><b>{fmtBytes(renderState.bytes)}</b></span>
        </div>
        <div className="speckle-prep-technical-note">
          <b>PHD3D Spatial GPU-ready</b>
          <span>{state.detail}</span>
          <span>{renderState.detail}</span>
        </div>
      </details>
    </div>

    <footer className="connection-actions speckle-prep-actions">
      <button className="outline-action" disabled={building||renderBuilding} onClick={refreshStatus}>
        <RefreshCw size={14}/>Atualizar status
      </button>
      <button
        className="primary-action"
        disabled={primaryDisabled}
        onClick={primaryPublishes?buildRenderCache:viewerReadyPartial?prepare:prepareServer}
      >
        {building||renderBuilding?<Loader2 size={14} className="animate-spin"/>:primaryPublishes?<Rocket size={14}/>:<DatabaseZap size={14}/>}
        {primaryLabel}
      </button>
    </footer>
  </section>;
}
