import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CloudDownload, Cpu, DatabaseZap, ExternalLink, Loader2, PlayCircle, Settings2, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import usePHDNativeBatchedViewer from '@/components/twin/usePHDNativeBatchedViewer';
import { listRenderableObjectIndices, loadBundleCollectionGroups, loadBundleGeometryBatch, loadBundleMaterialColorMap, loadBundleMaterialColors } from '@/components/twin/bundleBrowserGeometry';
import useFourDSimulation, { FOUR_D_PHASES } from '@/components/twin/useFourDSimulation';
import { attachHyperViewRenderCache, buildHyperViewRenderCache, findReadyHyperViewRenderCache } from '@/components/twin/hyperViewRenderCache';
import {
  findReadyGeometryCache,
  findUsableGeometryCache,
  loadGeometryCacheChunk,
  repairGeometryCacheChunkBounds,
  prepareGeometryCacheFiles,
  uploadPreparedGeometryCacheFiles,
  updateGeometryCacheManifest,
  getPHDLocalCacheStatus,
  getPHDLocalFastCacheStatus,
  hydratePHDLocalCacheFromRenderPacks,
  buildPHDLocalFastCache,
  persistPHDLocalChunkColors
} from '@/components/twin/geometryPersistentCache';

const STANDARD_LOAD_CONCURRENCY=10;
const FAST_LOAD_CONCURRENCY=20;
const SPATIAL_BUDGETS={overview:32,medium:22,detail:14};
const SET_PALETTE=['#1495ff','#22d388','#ffb547','#b56cff','#16c7d9','#ff6b66','#5a7cff','#9fd356','#ff7ab8','#5fd1ff'];
const MODEL_FALLBACK_PALETTE=[
  '#8f969c','#9aa0a6','#7d8790','#a9adb1','#7e8f9e','#91989f'
];

function stableHash(value){
  let hash=2166136261;
  for(const char of String(value||'')){
    hash^=char.charCodeAt(0);
    hash=Math.imul(hash,16777619);
  }
  return hash>>>0;
}

function semanticColorForName(name){
  const text=String(name||'').toLowerCase();

  // Paleta de leitura industrial inspirada em modelos de coordenação:
  // estrutura = azul aço, tubulação = branco, equipamentos = turquesa,
  // acesso/guarda-corpo = amarelo e contexto = cinza neutro.
  if(/handrail|guarda.?corpo|corrim[aã]o|railing|escada|stair|plataforma|platform|grating/i.test(text))return '#d9d11a';
  if(/pipe|piping|tub|spool|linha|process|processo/i.test(text))return '#eef1f3';
  if(/mechan|mec[aâ]n|equip|pump|bomba|motor|crusher|britador|filter|filtro/i.test(text))return '#31b9b7';
  if(/struct|estrutura|steel|metal|frame|treli|support|suporte/i.test(text))return '#2c6f9f';
  if(/electric|el[eé]tr|cable|eletro|tray|leito/i.test(text))return '#d99524';
  if(/instrument|instrum|control|autom/i.test(text))return '#6fae70';
  if(/hvac|duct|duto|vent/i.test(text))return '#6fb9c9';
  if(/civil|concrete|concreto|terreno|terrain|earth|solo|fund|road|pav/i.test(text))return '#8d9094';
  if(/architect|arquitet|building|pr[eé]dio/i.test(text))return '#d6d8da';

  return MODEL_FALLBACK_PALETTE[stableHash(text)%MODEL_FALLBACK_PALETTE.length];
}

function saneBounds(bounds){
  if(!Array.isArray(bounds)||bounds.length!==6||bounds.some(value=>!Number.isFinite(Number(value))))return false;
  const values=bounds.map(Number);
  if(values.some(value=>Math.abs(value)>1e9))return false;
  const dx=Math.abs(values[3]-values[0]);
  const dy=Math.abs(values[4]-values[1]);
  const dz=Math.abs(values[5]-values[2]);
  return Math.hypot(dx,dy,dz)<1e8;
}

function mergeBounds(descriptors){
  let result=null;
  for(const descriptor of descriptors||[]){
    const bounds=descriptor?.bounds;
    if(!saneBounds(bounds))continue;
    if(!result){
      result=bounds.map(Number);
      continue;
    }
    result[0]=Math.min(result[0],Number(bounds[0]));
    result[1]=Math.min(result[1],Number(bounds[1]));
    result[2]=Math.min(result[2],Number(bounds[2]));
    result[3]=Math.max(result[3],Number(bounds[3]));
    result[4]=Math.max(result[4],Number(bounds[4]));
    result[5]=Math.max(result[5],Number(bounds[5]));
  }
  return result;
}

function distributedOverviewChunks(descriptors,max=64){
  const source=(descriptors||[]).filter(item=>Array.isArray(item?.center)&&item.center.length===3);
  if(source.length<=max)return source;
  const bounds=mergeBounds(source);
  if(!bounds)return source.slice(0,max);

  const center=[
    (bounds[0]+bounds[3])/2,
    (bounds[1]+bounds[4])/2,
    (bounds[2]+bounds[5])/2
  ];
  const span=[
    Math.max(1,Math.abs(bounds[3]-bounds[0])),
    Math.max(1,Math.abs(bounds[4]-bounds[1])),
    Math.max(1,Math.abs(bounds[5]-bounds[2]))
  ];
  const normalized=item=>[
    (Number(item.center[0])-center[0])/span[0],
    (Number(item.center[1])-center[1])/span[1],
    (Number(item.center[2])-center[2])/span[2]
  ];
  const points=source.map(item=>({item,p:normalized(item)}));
  const dist2=(a,b)=>{
    const dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];
    return dx*dx+dy*dy+dz*dz;
  };

  let seed=points[0];
  let best=Infinity;
  for(const candidate of points){
    const d=dist2(candidate.p,[0,0,0]);
    if(d<best){best=d;seed=candidate}
  }

  const selected=[seed];
  const selectedSet=new Set([seed.item]);
  const minDistance=new Map(points.map(point=>[point.item,dist2(point.p,seed.p)]));

  while(selected.length<max){
    let next=null,nextDistance=-1;
    for(const point of points){
      if(selectedSet.has(point.item))continue;
      const d=minDistance.get(point.item)??Infinity;
      if(d>nextDistance){nextDistance=d;next=point}
    }
    if(!next)break;
    selected.push(next);
    selectedSet.add(next.item);
    for(const point of points){
      if(selectedSet.has(point.item))continue;
      const current=minDistance.get(point.item)??Infinity;
      minDistance.set(point.item,Math.min(current,dist2(point.p,next.p)));
    }
  }
  return selected.map(entry=>entry.item);
}

function chunkKey(descriptor){
  return 'detail:'+String(descriptor?.chunkIndex);
}

export default function BundleViewerCanvas({ connection, selected, bridge, setModelState, onRoot, onSelected, enable4D=false }) {
  const host=useRef(null);
  const loadKey=useRef('');
  const globalBoundsRef=useRef(null);
  const spatialRuntimeRef=useRef(null);
  const fourDInitRef=useRef('');
  const fourDColorStateRef=useRef(new Map());
  const setIsolationRef=useRef(null);
  const setColorMapRef=useRef(null);
  const originalColorMapRef=useRef(null);
  const visualBaseColorMapRef=useRef(null);
  const perfRef=useRef({start:0,firstPixels:0,interactive:0});
  const navigate=useNavigate();
  const [loadState,setLoadState]=useState({
    status:'idle',
    progress:0,
    phase:'Aguardando',
    detail:'',
    error:'',
    totalObjects:0,
    objectCount:0,
    meshCount:0,
    invalidCount:0,
    activeChunks:0,
    totalSpatialChunks:0
  });
  const [filterState,setFilterState]=useState({hidden:0,isolated:0,colorGroups:0});
  const [auto4D,setAuto4D]=useState(false);

  const native=usePHDNativeBatchedViewer(host,onSelected);
  const simulation=useFourDSimulation(connection,undefined,enable4D);

  const viewerUrl=useMemo(()=>{
    if(!connection?.project_id||!connection?.model_id)return '';
    const version=connection?.version_id?('@'+connection.version_id):'';
    return 'https://app.speckle.systems/projects/'+connection.project_id+'/models/'+connection.model_id+version;
  },[connection?.project_id,connection?.model_id,connection?.version_id]);

  useEffect(()=>{
    onRoot?.(null);
    setFilterState({hidden:0,isolated:0,colorGroups:0});
    setAuto4D(false);
    setLoadState({
      status:'loading',
      progress:0,
      phase:'INICIANDO MODELO 3D',
      detail:'Preparando carregamento…',
      error:'',
      totalObjects:0,
      objectCount:0,
      meshCount:0,
      invalidCount:0,
      activeChunks:0,
      totalSpatialChunks:0,
      fullModel:false,
      firstLoadReady:false,
      appearanceReady:false,
      coloredObjectCount:0,
      localChunks:0,
      fastChunks:0,
      networkChunks:0
    });
    fourDInitRef.current='';
    fourDColorStateRef.current.clear();
    loadKey.current='';
    globalBoundsRef.current=null;
    spatialRuntimeRef.current=null;
    setIsolationRef.current=null;
    setColorMapRef.current=null;
    originalColorMapRef.current=null;
    visualBaseColorMapRef.current=null;
    perfRef.current={start:0,firstPixels:0,interactive:0};
  },[connection?.id,connection?.version_id,onRoot]);

  useEffect(()=>{
    if(!native.ready||!connection?.id||!connection?.version_id)return;

    const key=[connection.id,connection.version_id].join(':');
    if(loadKey.current===key)return;
    loadKey.current=key;
    perfRef.current={start:performance.now(),firstPixels:0,interactive:0};

    let cancelled=false;
    let spatialBusy=false;
    let appearanceReady=false;
    let globalAppearancePromise=null;
    let visualAppearancePromise=null;
    const loadedDetail=new Set();
    const emptyChunks=new Set();
    const coloredObjectIndices=new Set();

    const fail=(message)=>{
      if(cancelled)return;
      setLoadState(current=>({
        ...current,
        status:'error',
        error:message,
        phase:'Falha no cache espacial',
        detail:message
      }));
      setModelState({
        status:'ERRO NO VIEWER LOCAL',
        count:null,
        bundle:true,
        nativeViewer:true,
        persistentCache:true,
        spatialStreaming:true,
        streaming:false,
        progress:0,
        phase:'Falha no cache espacial',
        detail:message
      });
    };

    const run=async()=>{
      try{
        native.clearModel();
        setLoadState(current=>({
          ...current,
          status:'loading',
          progress:1,
          phase:'Verificando PHD3D Spatial v3',
          detail:'Localizando preview e índice espacial no storage privado',
          error:''
        }));

        const cache=await findUsableGeometryCache(connection);
        if(cancelled)return;

        if(!cache?.chunks?.length){
          setLoadState({
            status:'needs-preparation',
            progress:0,
            phase:'Modelo não preparado',
            detail:'Esta versão ainda não possui chunks PHD3D utilizáveis.',
            error:'',
            totalObjects:0,
            objectCount:0,
            meshCount:0,
            invalidCount:0,
            activeChunks:0,
            totalSpatialChunks:0
          });
          setModelState({
            status:'MODELO NÃO PREPARADO',
            count:null,
            bundle:true,
            eav:true,
            nativeViewer:true,
            persistentCache:false,
            spatialStreaming:false,
            streaming:false,
            progress:0,
            phase:'Preparação necessária',
            detail:'Abra Configurações e inicie a preparação. O Viewer abre assim que houver chunks utilizáveis.'
          });
          return;
        }

        const localCacheStatus=await getPHDLocalCacheStatus();
        let runtimePersisted=!!localCacheStatus?.persisted;

        // Preferência máxima: HyperView Render Cache persistido no servidor.
        // Ele agrupa centenas de PHD3D pequenos em poucos packs grandes, já
        // ordenados para first paint, reduzindo signed URLs e round-trips.
        const renderCache=await findReadyHyperViewRenderCache(connection,cache);
        const chunks=attachHyperViewRenderCache(
          [...cache.chunks].sort((a,b)=>Number(a.chunkIndex)-Number(b.chunkIndex)),
          renderCache
        );
        const renderCacheReady=!!renderCache?.packs?.length;
        const serverTotalChunks=Number(cache.total_chunks||chunks.length||0);
        const serverCachedChunks=Number(cache.cached_chunks||chunks.length||0);
        const serverCacheComplete=String(cache.status||'').toLowerCase()==='ready'&&
          serverTotalChunks>0&&serverCachedChunks>=serverTotalChunks;
        const fastCacheStatus=await getPHDLocalFastCacheStatus(cache.cache_key,chunks);
        const fastMode=!!fastCacheStatus.ready;
        let runtimeFastReady=fastMode;
        let runtimeFastPacks=Number(fastCacheStatus?.packs||0);
        let atomicLocalOpen=fastMode;
        const loadConcurrency=renderCacheReady?24:fastMode?FAST_LOAD_CONCURRENCY:STANDARD_LOAD_CONCURRENCY;
        let previewChunks=chunks.filter(item=>item.role==='preview'||Number(item.lod)===0);
        let detailChunks=chunks.filter(item=>!previewChunks.includes(item));

        if(!previewChunks.length&&chunks.length){
          previewChunks=[chunks[0]];
          detailChunks=chunks.slice(1);
        }

        // A preparação retira os objetos do preview do lote de detalhe para
        // não duplicá-los. Portanto o modelo completo é Preview + Detail/Repair.
        // Ignorar o preview aqui eliminava ~192 objetos reais da visualização.
        const selectableChunks=detailChunks.length
          ? [...previewChunks,...detailChunks]
          : previewChunks;
        const badBoundsChunks=detailChunks.filter(item=>!saneBounds(item.bounds));
        const saneDetailChunks=detailChunks.filter(item=>saneBounds(item.bounds));
        const indexedObjects=Number(cache.total_objects||cache.cached_objects||0);
        const totalObjects=Number(cache.cached_objects||cache.total_objects||0);
        const missingPreparedObjects=Math.max(0,indexedObjects-totalObjects);
        const geometryCoverage=indexedObjects?Math.min(100,(totalObjects/indexedObjects)*100):100;
        const globalBounds=mergeBounds(saneDetailChunks.length?saneDetailChunks:chunks);
        globalBoundsRef.current=globalBounds;

        // Floating origin: modelos federados chegam georreferenciados em
        // coordenadas muito altas. Recentrar apenas o renderer elimina perda
        // de precisão na órbita, raycast, zoom e clipping.
        if(globalBounds)native.setWorldOrigin(globalBounds);
        const proxyResult=native.setSpatialProxyBounds(saneDetailChunks);
        if(globalBounds)native.fitBounds(globalBounds);

        setLoadState(current=>({
          ...current,
          status:'loading',
          progress:0,
          phase:'CARREGANDO MODELO 3D',
          detail:'Preparando o primeiro carregamento completo…',
          error:'',
          totalObjects,
          indexedObjectCount:indexedObjects,
          missingPreparedObjects,
          geometryCoverage,
          objectCount:0,
          meshCount:0,
          activeChunks:0,
          totalSpatialChunks:selectableChunks.length,
          proxyCount:Number(proxyResult?.count||0),
          serverCacheComplete,
          serverCachedChunks,
          serverTotalChunks,
          renderCacheReady,
          renderPackCount:Number(renderCache?.pack_count||renderCache?.packs?.length||0),
          renderCacheBytes:Number(renderCache?.total_bytes||0),
          fullModel:false,
          appearanceReady:false,
          coloredObjectCount:0,
          localChunks:0,
          fastChunks:0,
          networkChunks:0
        }));
        setModelState({
          status:'CARREGANDO MODELO',
          count:totalObjects,
          activeObjectCount:0,
          bundle:true,
          eav:true,
          nativeViewer:true,
          persistentCache:true,
          spatialStreaming:true,
          streaming:true,
          renderer:'PHD HyperView · Adaptive Spatial Streaming v5',
          geometryMeshes:0,
          activeChunks:0,
          totalSpatialChunks:selectableChunks.length,
          proxyChunks:Number(proxyResult?.count||0),
          serverCacheComplete,
          serverCachedChunks,
          serverTotalChunks,
          renderCacheReady,
          renderPackCount:Number(renderCache?.pack_count||renderCache?.packs?.length||0),
          renderCacheBytes:Number(renderCache?.total_bytes||0),
          selection:true,
          camera:true,
          filtering:true,
          simulation4d:true,
          progress:0,
          phase:'Carregando viewport prioritário',
          detail:'Abertura rápida: carregando apenas a região necessária para tornar o viewer interativo.'
        });

        // O preview real antigo não é mais carregado na abertura. Alguns desses
        // objetos são terrenos/malhas muito grandes e competiam visualmente com
        // as instalações. O contexto global agora é o LOD 0 por bounds; a
        // geometria real entra apenas pelo ranking visual ou por seleção.

        const descriptorMap=new Map(selectableChunks.map(item=>[chunkKey(item),item]));
        let pinnedChunkKey=null;
        let activeBudget=SPATIAL_BUDGETS.medium;
        let firstLoadTarget=1;
        let interactiveReady=false;
        let recoveredObjectCount=0;
        let recoveredInstanceCount=0;
        let recoveryMissingCount=0;
        let recoveryUnresolvedCount=0;
        let recoveryComplete=false;
        let revealed=false;

        const spatialState=()=>{
          let detailObjectCount=0;
          let detailInstanceCount=0;
          for(const keyValue of loadedDetail){
            const descriptor=descriptorMap.get(keyValue);
            detailObjectCount+=Number(descriptor?.objectCount||0);
            detailInstanceCount+=Number(descriptor?.instanceCount||0);
          }

          const activeObjects=detailObjectCount+recoveredObjectCount;
          const activeInstances=detailInstanceCount+recoveredInstanceCount;
          const loadedChunks=loadedDetail.size;
          const totalChunks=selectableChunks.length;
          const visualReady=activeObjects>0&&loadedChunks>0;
          const fullModel=totalChunks>0&&(loadedChunks+emptyChunks.size)>=totalChunks;
          const residentProgress=totalChunks
            ? Math.min(100,Math.round(((loadedChunks+emptyChunks.size)/totalChunks)*100))
            : 0;
          const initialLoaded=Math.min(loadedChunks+emptyChunks.size,Math.max(1,firstLoadTarget));
          const geometryReady=visualReady&&initialLoaded>=Math.max(1,firstLoadTarget);
          const ready=geometryReady&&appearanceReady;
          interactiveReady=interactiveReady||ready;

          const now=performance.now();
          if(visualReady&&!perfRef.current.firstPixels){
            perfRef.current.firstPixels=Math.max(0,now-perfRef.current.start);
          }
          if(interactiveReady&&!perfRef.current.interactive){
            perfRef.current.interactive=Math.max(0,now-perfRef.current.start);
          }

          let progress=Math.min(90,Math.round((initialLoaded/Math.max(1,firstLoadTarget))*90));
          if(geometryReady&&!appearanceReady)progress=96;
          if(interactiveReady)progress=100;

          let localChunks=0,fastChunks=0,renderPackChunks=0,networkChunks=0;
          for(const keyValue of loadedDetail){
            const descriptor=descriptorMap.get(keyValue);
            if(descriptor?.__cacheSource==='fast'){fastChunks++;localChunks++}
            else if(descriptor?.__cacheSource==='local')localChunks++;
            else if(descriptor?.__cacheSource==='render-pack')renderPackChunks++;
            else if(descriptor?.__cacheSource==='network')networkChunks++;
          }
          const cacheHitRatio=loadedChunks
            ? Math.round(((localChunks+fastChunks)/loadedChunks)*100)
            : 0;

          setLoadState(current=>({
            ...current,
            status:interactiveReady?'ready':'loading',
            progress,
            phase:interactiveReady?'VIEWER INTERATIVO':'CARREGANDO VIEWPORT 3D',
            detail:interactiveReady
              ? loadedChunks.toLocaleString('pt-BR')+' chunks ativos de '+totalChunks.toLocaleString('pt-BR')+
                ' · streaming adaptativo por câmera'
              : initialLoaded.toLocaleString('pt-BR')+' / '+Math.max(1,firstLoadTarget).toLocaleString('pt-BR')+
                ' chunks prioritários · '+activeObjects.toLocaleString('pt-BR')+' objetos',
            error:'',
            totalObjects,
            indexedObjectCount:indexedObjects,
            missingPreparedObjects,
            geometryCoverage,
            objectCount:activeObjects,
            meshCount:activeInstances,
            activeChunks:loadedChunks,
            totalSpatialChunks:totalChunks,
            chunkBudget:activeBudget,
            firstLoadTarget,
            fullModel,
            residentProgress,
            recoveryMissingCount,
            recoveredObjectCount,
            recoveryUnresolvedCount,
            recoveryComplete,
            firstLoadReady:interactiveReady,
            localChunks,
            fastChunks,
            renderPackChunks,
            networkChunks,
            cacheHitRatio,
            ttfpMs:Math.round(perfRef.current.firstPixels||0),
            ttiMs:Math.round(perfRef.current.interactive||0),
            coloredObjectCount:coloredObjectIndices.size,
            appearanceReady,
            fastCacheReady:runtimeFastReady,
            fastCachePacks:runtimeFastPacks,
            localCacheSupported:!!localCacheStatus?.supported,
            localCachePersisted:runtimePersisted
          }));

          setModelState({
            status:interactiveReady?'READY':'CARREGANDO MODELO',
            count:totalObjects,
            indexedObjectCount:indexedObjects,
            missingPreparedObjects,
            geometryCoverage,
            activeObjectCount:activeObjects,
            bundle:true,
            eav:true,
            nativeViewer:true,
            persistentCache:true,
            spatialStreaming:false,
            streaming:!fullModel,
            fullModel,
            residentProgress,
            recoveryMissingCount,
            recoveredObjectCount,
            recoveryUnresolvedCount,
            recoveryComplete,
            firstLoadReady:interactiveReady,
            renderer:renderCacheReady?'PHD HyperView · Full Residency + Render Cache v9':'PHD HyperView · Full Residency v9',
            geometryMeshes:activeInstances,
            activeChunks:loadedChunks,
            totalSpatialChunks:totalChunks,
            serverCacheComplete,
            serverCachedChunks,
            serverTotalChunks,
            renderCacheReady,
            renderPackCount:Number(renderCache?.pack_count||renderCache?.packs?.length||0),
            renderCacheBytes:Number(renderCache?.total_bytes||0),
            selection:true,
            camera:true,
            filtering:true,
            simulation4d:true,
            progress,
            localChunks,
            fastChunks,
            renderPackChunks,
            networkChunks,
            cacheHitRatio,
            ttfpMs:Math.round(perfRef.current.firstPixels||0),
            ttiMs:Math.round(perfRef.current.interactive||0),
            fastCacheReady:runtimeFastReady,
            fastCachePacks:runtimeFastPacks,
            localCacheSupported:!!localCacheStatus?.supported,
            localCachePersisted:runtimePersisted,
            phase:fullModel?'Modelo completo residente':interactiveReady?'Carregando modelo completo':'Carregando viewport prioritário',
            detail:fullModel
              ? 'Todo o PHD3D preparado está carregado no Viewer.'
              : interactiveReady
                ? loadedChunks.toLocaleString('pt-BR')+' / '+totalChunks.toLocaleString('pt-BR')+' chunks residentes · carregamento continua em segundo plano.'
                : 'A barra acompanha o conjunto inicial necessário para liberar a navegação.'
          });

          if(visualReady&&!revealed){
            revealed=true;
          }

        };

        const getGlobalAppearance=()=>{
          if(!globalAppearancePromise){
            globalAppearancePromise=loadBundleMaterialColorMap(connection)
              .then(colors=>{
                if(colors?.size)originalColorMapRef.current=colors;
                return colors;
              })
              .catch(()=>null);
          }
          return globalAppearancePromise;
        };

        const getVisualAppearance=()=>{
          if(!visualAppearancePromise){
            visualAppearancePromise=(async()=>{
              const original=await getGlobalAppearance();
              const visual=new Map(original?.size?original:[]);
              try{
                const groups=await loadBundleCollectionGroups(connection);
                for(const group of groups||[]){
                  const fallback=semanticColorForName(group?.name);
                  for(const rawIndex of group?.objectIndices||[]){
                    const objectIndex=Number(rawIndex);
                    if(Number.isFinite(objectIndex)&&!visual.has(objectIndex)){
                      visual.set(objectIndex,fallback);
                    }
                  }
                }
              }catch{}
              visualBaseColorMapRef.current=visual;
              return visual;
            })();
          }
          return visualAppearancePromise;
        };

        const applyRuntimeColors=async results=>{
          const unresolvedResults=(results||[]).filter(item=>item.descriptor?.__localColorsComplete!==true);
          if(!unresolvedResults.length)return;

          const missing=[];
          for(const item of unresolvedResults){
            for(const object of item.objects||[]){
              if(!object.displayColor)missing.push(object);
            }
          }

          if(missing.length){
            // Uma única resolução global da aparência por versão. Isso evita
            // centenas de chamadas materialColorsBatch durante o primeiro load.
            const visualColors=await getVisualAppearance();
            if(visualColors?.size){
              for(const object of missing){
                const color=visualColors.get(Number(object.objectIndex));
                if(color)object.displayColor=color;
              }
            }else{
              // Fallback pontual para bundles antigos/atípicos.
              const materialColors=await loadBundleMaterialColors(
                connection,
                missing.map(object=>object.objectIndex)
              );
              for(const object of missing){
                const color=materialColors.get(Number(object.objectIndex));
                if(color)object.displayColor=color;
              }
            }
          }

          // Sidecar v4: nas próximas aberturas a cor entra junto com a geometria,
          // sem refazer o grafo de aparência.
          await Promise.all(unresolvedResults.map(item=>
            persistPHDLocalChunkColors(item.descriptor,item.objects||[])
          ));
        };

        let colorHydrationChain=Promise.resolve();

        const loadDescriptorGroup=async descriptors=>{
          const pending=descriptors.filter(descriptor=>{
            const currentKey=chunkKey(descriptor);
            return !loadedDetail.has(currentKey)&&!emptyChunks.has(currentKey)&&!native.hasChunk(currentKey);
          });
          if(!pending.length)return;

          let offset=0;
          while(offset<pending.length){
            if(cancelled)return;
            // Primeiro paint propositalmente pequeno: não esperamos 20 chunks
            // de rede antes de mostrar qualquer coisa. Depois do primeiro frame,
            // a concorrência sobe automaticamente.
            const currentConcurrency=revealed?loadConcurrency:Math.min(4,loadConcurrency);
            const group=pending.slice(offset,offset+currentConcurrency);
            offset+=currentConcurrency;
            const results=await Promise.all(group.map(async descriptor=>({
              descriptor,
              objects:await loadGeometryCacheChunk(descriptor)
            })));
            if(cancelled)return;

            // No primeiro frame aguardamos somente a hidratação de aparência.
            // Assim o usuário nunca vê o modelo cinza antes das cores originais.
            if(!revealed){
              await applyRuntimeColors(results);
              if(cancelled)return;
            }

            // FIRST PAINT: monta a geometria imediatamente com a cor original
            // já disponível no cache/resolvedor. A hidratação dos próximos lotes acontece
            // depois, em background, sem bloquear a primeira visualização.
            // Cada chunk vira um BatchedMesh independente. Isso mantém os
            // draw calls baixos, mas permite retirar da GPU regiões que saíram
            // da câmera — essencial em modelos com centenas de milhares de objetos.
            for(const item of results){
              const currentKey=chunkKey(item.descriptor);
              const objects=item.objects||[];
              if(objects.length){
                native.appendObjects(objects,{
                  fit:false,
                  chunkKey:currentKey
                });
                loadedDetail.add(currentKey);
                native.setSpatialProxyVisible(currentKey,false);
              }else{
                emptyChunks.add(currentKey);
              }
            }

            // Revela o modelo assim que o primeiro lote renderizável entra.
            spatialState();

            // Resolve e aplica materiais em uma fila serial. Assim evitamos
            // dezenas de consultas simultâneas ao Speckle enquanto o 3D carrega.
            colorHydrationChain=colorHydrationChain.then(async()=>{
              if(cancelled)return;
              await applyRuntimeColors(results);
              if(cancelled)return;
              let changed=false;
              for(const item of results){
                for(const object of item.objects||[]){
                  const objectIndex=Number(object.objectIndex);
                  if(object.displayColor){
                    coloredObjectIndices.add(objectIndex);
                    changed=native.setObjectBaseColor?.(objectIndex,object.displayColor,false)||changed;
                  }
                  const semanticColor=setColorMapRef.current?.get(objectIndex);
                  if(semanticColor){
                    changed=native.setObjectColor?.(objectIndex,semanticColor,false)||changed;
                  }
                }
              }
              if(setIsolationRef.current)native.isolateMany?.([...setIsolationRef.current]);
              if(changed)native.render?.();
            }).catch(()=>{});

            // Entrega o event loop entre lotes para manter órbita/pan responsivos.
            await new Promise(resolve=>setTimeout(resolve,0));
          }
        };

        spatialState();
        if(enable4D)void simulation.refresh();

        const overviewChunks=renderCacheReady
          ? selectableChunks
              .filter(item=>Number(item.renderPackIndex)===0)
              .sort((a,b)=>Number(a.renderPackOffset||0)-Number(b.renderPackOffset||0))
          : distributedOverviewChunks(
              selectableChunks,
              Math.min(fastMode?80:64,selectableChunks.length)
            );

        const loadInitialPriority=async()=>{
          if(cancelled||spatialBusy||!selectableChunks.length)return;
          spatialBusy=true;
          try{
            activeBudget=native.getSpatialLoadBudget(selectableChunks,SPATIAL_BUDGETS);
            firstLoadTarget=Math.max(1,overviewChunks.length);
            setLoadState(current=>({
              ...current,
              phase:'ABRINDO MODELO COMPLETO DA BASE',
              detail:'Base PHD3D pronta · '+serverCachedChunks.toLocaleString('pt-BR')+' / '+
                serverTotalChunks.toLocaleString('pt-BR')+
                ' chunks armazenados · montando visão geral distribuída'
            }));
            await loadDescriptorGroup(overviewChunks);
          }finally{
            spatialBusy=false;
          }
        };

        const loadAllResidentOptimized=async()=>{
          if(cancelled||spatialBusy||!selectableChunks.length)return;
          spatialBusy=true;
          try{
            if(atomicLocalOpen){
              firstLoadTarget=Math.max(1,selectableChunks.length);
              setLoadState(current=>({
                ...current,
                status:'loading',
                progress:Math.max(1,Number(current.progress||0)),
                phase:'ABRINDO MODELO DO CACHE LOCAL',
                detail:'Versão já armazenada neste computador · montando o modelo completo antes de liberar o viewer.',
                atomicLocalOpen:true,
                firstLoadTarget:selectableChunks.length
              }));
            }
            const remaining=selectableChunks.filter(descriptor=>{
              const currentKey=chunkKey(descriptor);
              return !loadedDetail.has(currentKey)&&!emptyChunks.has(currentKey);
            });
            const batchSize=atomicLocalOpen?16:(renderCacheReady||runtimeFastReady?8:4);
            let residentBatch=0;

            for(let offset=0;offset<remaining.length&&!cancelled;offset+=batchSize){
              const group=remaining.slice(offset,offset+batchSize);
              const results=await Promise.all(group.map(async descriptor=>({
                descriptor,
                objects:await loadGeometryCacheChunk(descriptor)
              })));
              if(cancelled)return;

              await applyRuntimeColors(results);
              if(cancelled)return;

              const mergedObjects=[];
              for(const item of results){
                const currentKey=chunkKey(item.descriptor);
                const objects=item.objects||[];
                if(objects.length){
                  mergedObjects.push(...objects);
                  loadedDetail.add(currentKey);
                  native.setSpatialProxyVisible(currentKey,false);
                }else{
                  emptyChunks.add(currentKey);
                }
              }

              if(mergedObjects.length){
                residentBatch++;
                native.appendObjects(mergedObjects,{
                  fit:false,
                  chunkKey:'resident:'+residentBatch
                });

                let changed=false;
                for(const object of mergedObjects){
                  const objectIndex=Number(object.objectIndex);
                  if(object.displayColor){
                    coloredObjectIndices.add(objectIndex);
                    changed=native.setObjectBaseColor?.(objectIndex,object.displayColor,false)||changed;
                  }
                  const semanticColor=setColorMapRef.current?.get(objectIndex);
                  if(semanticColor){
                    changed=native.setObjectColor?.(objectIndex,semanticColor,false)||changed;
                  }
                }
                if(changed)native.render?.();
              }

              spatialState();
              const done=loadedDetail.size+emptyChunks.size;
              const pct=Math.min(100,Math.round((done/Math.max(1,selectableChunks.length))*100));
              setLoadState(current=>({
                ...current,
                status:atomicLocalOpen?'loading':'ready',
                progress:atomicLocalOpen?Math.max(1,Math.min(94,pct)):current.progress,
                phase:atomicLocalOpen?'MONTANDO MODELO LOCAL':'CARREGANDO MODELO COMPLETO',
                detail:done.toLocaleString('pt-BR')+' / '+
                  selectableChunks.length.toLocaleString('pt-BR')+
                  ' chunks residentes · '+pct+'%',
                residentProgress:pct,
                atomicLocalOpen
              }));

              await new Promise(resolve=>setTimeout(resolve,8));
            }

            if(cancelled)return;
            spatialState();
            setLoadState(current=>({
              ...current,
              status:atomicLocalOpen?'loading':'ready',
              progress:atomicLocalOpen?95:current.progress,
              phase:atomicLocalOpen?'MODELO LOCAL MONTADO':'MODELO COMPLETO RESIDENTE',
              detail:Number(current.objectCount||0).toLocaleString('pt-BR')+
                ' objetos 3D carregados · nenhum descarte espacial ativo',
              residentProgress:100,
              fullModel:true,
              atomicLocalOpen
            }));
            requestAnimationFrame(()=>native.renderPremium?.());
          }catch(error){
            setLoadState(current=>({
              ...current,
              status:interactiveReady?'ready':'loading',
              phase:'CARREGAMENTO COMPLETO',
              detail:(error?.message||'Falha temporária em um lote')+
                ' · mantendo todo conteúdo já carregado'
            }));
          }finally{
            spatialBusy=false;
          }
        };

        const recoverMissingGeometry=async()=>{
          if(cancelled)return;
          try{
            setLoadState(current=>({
              ...current,
              status:'ready',
              phase:'AUDITANDO COBERTURA 3D',
              detail:'Comparando os objetos indexados com tudo que está residente no viewer…'
            }));

            const indexed=await listRenderableObjectIndices(connection,{limit:1000000});
            if(cancelled)return;
            const missing=indexed.filter(index=>!native.hasObject(Number(index)));
            recoveryMissingCount=missing.length;

            if(!missing.length){
              recoveryUnresolvedCount=0;
              recoveryComplete=true;
              spatialState();
              requestAnimationFrame(()=>native.renderPremium?.());
              return;
            }

            setLoadState(current=>({
              ...current,
              status:'ready',
              phase:'RECUPERANDO GEOMETRIA AUSENTE',
              detail:missing.length.toLocaleString('pt-BR')+
                ' objetos serão relidos diretamente do Bundle e adicionados ao viewer.',
              recoveryMissingCount:missing.length
            }));

            const recoveredObjects=[];
            const recoveredSet=new Set();
            const batchSize=256;
            let batchNumber=0;

            for(let offset=0;offset<missing.length&&!cancelled;offset+=batchSize){
              const batch=missing.slice(offset,offset+batchSize);
              let result=null;
              try{
                result=await loadBundleGeometryBatch(connection,batch,{
                  limit:8192,
                  maxObjects:batch.length,
                  includeMaterialColors:true
                });
              }catch{
                result=null;
              }
              if(cancelled)return;

              const objects=result?.objects||[];
              if(objects.length){
                batchNumber++;
                const unique=objects.filter(object=>{
                  const index=Number(object.objectIndex);
                  if(!Number.isFinite(index)||native.hasObject(index)||recoveredSet.has(index))return false;
                  recoveredSet.add(index);
                  return true;
                });

                if(unique.length){
                  native.appendObjects(unique,{
                    fit:false,
                    chunkKey:'recovery:'+batchNumber
                  });
                  for(const object of unique){
                    const index=Number(object.objectIndex);
                    if(object.displayColor)native.setObjectBaseColor?.(index,object.displayColor,false);
                    const semanticColor=setColorMapRef.current?.get(index);
                    if(semanticColor)native.setObjectColor?.(index,semanticColor,false);
                    coloredObjectIndices.add(index);
                  }
                  recoveredObjects.push(...unique);
                  recoveredObjectCount=recoveredSet.size;
                  recoveredInstanceCount=recoveredObjects.reduce(
                    (sum,object)=>sum+Number(object?.rows?.length||0),0
                  );
                  native.render?.();
                }
              }

              recoveryUnresolvedCount=Math.max(0,missing.length-recoveredSet.size);
              spatialState();
              setLoadState(current=>({
                ...current,
                status:'ready',
                phase:'RECUPERANDO GEOMETRIA AUSENTE',
                detail:Math.min(offset+batch.length,missing.length).toLocaleString('pt-BR')+
                  ' / '+missing.length.toLocaleString('pt-BR')+
                  ' auditados · '+recoveredSet.size.toLocaleString('pt-BR')+
                  ' recuperados · '+recoveryUnresolvedCount.toLocaleString('pt-BR')+' sem malha válida'
              }));

              await new Promise(resolve=>setTimeout(resolve,10));
            }

            if(cancelled)return;

            // Persiste somente o que realmente foi recuperado. Na próxima
            // abertura esses objetos já farão parte do PHD3D da Base44.
            if(recoveredObjects.length&&cache?.id){
              try{
                setLoadState(current=>({
                  ...current,
                  phase:'SALVANDO RECUPERAÇÃO NA BASE44',
                  detail:recoveredObjects.length.toLocaleString('pt-BR')+
                    ' objetos recuperados serão incorporados ao cache PHD3D.'
                }));
                const nextChunkIndex=chunks.length
                  ? Math.max(...chunks.map(item=>Number(item.chunkIndex)||0))+1
                  : 0;
                const prepared=await prepareGeometryCacheFiles(
                  connection,
                  recoveredObjects,
                  nextChunkIndex,
                  {role:'repair',lod:2,spatial:true}
                );
                const uploaded=await uploadPreparedGeometryCacheFiles(prepared,{concurrency:4});
                const merged=[...chunks,...uploaded];
                const nextCached=Math.min(
                  indexedObjects,
                  Number(cache.cached_objects||0)+recoveredSet.size
                );
                await updateGeometryCacheManifest(
                  cache,
                  merged,
                  nextCached,
                  'ready',
                  '',
                  {
                    nextBatchIndex:Number(cache.next_batch_index||0),
                    totalBatches:Number(cache.total_batches||0),
                    nextObjectOffset:Number(cache.next_object_offset||0),
                    preparationBatchSize:Number(cache.preparation_batch_size||0),
                    uploadFailures:Number(cache.upload_failures||0)
                  }
                );
                setLoadState(current=>({
                  ...current,
                  repairPersisted:true,
                  repairedChunks:uploaded.length
                }));
              }catch{
                // A recuperação já está no viewer; falha de persistência não
                // interrompe a sessão atual.
              }
            }

            recoveryUnresolvedCount=missing.filter(index=>!native.hasObject(Number(index))).length;
            recoveryComplete=true;
            spatialState();
            setLoadState(current=>({
              ...current,
              status:'ready',
              phase:'MODELO COMPLETO NO VIEWER',
              detail:(Number(cache.cached_objects||0)+recoveredObjectCount).toLocaleString('pt-BR')+
                ' objetos PHD3D disponíveis · '+
                recoveryUnresolvedCount.toLocaleString('pt-BR')+
                ' índices sem geometria renderizável no Bundle.'
            }));
            requestAnimationFrame(()=>native.renderPremium?.());
          }catch(error){
            recoveryComplete=true;
            setLoadState(current=>({
              ...current,
              status:'ready',
              phase:'MODELO CARREGADO',
              detail:'Modelo PHD3D carregado. Auditoria complementar: '+
                (error?.message||'não concluída')
            }));
          }
        };

        const ensureObjectLoaded=async objectIndex=>{
          const index=Number(objectIndex);
          if(!Number.isFinite(index))return false;
          if(native.hasObject(index))return true;

          while(spatialBusy&&!cancelled){
            await new Promise(resolve=>setTimeout(resolve,40));
          }
          if(cancelled)return false;

          const candidates=selectableChunks
            .filter(descriptor=>{
              const min=Number(descriptor.objectIndexMin);
              const max=Number(descriptor.objectIndexMax);
              return Number.isFinite(min)&&Number.isFinite(max)&&index>=min&&index<=max;
            })
            .sort((a,b)=>(Number(a.objectIndexMax)-Number(a.objectIndexMin))-(Number(b.objectIndexMax)-Number(b.objectIndexMin)));

          if(!candidates.length)return false;

          spatialBusy=true;
          try{
            setLoadState(current=>({
              ...current,
              phase:'Carregando objeto selecionado',
              detail:'Localizando ObjectIndex '+index.toLocaleString('pt-BR')+' no cache espacial…'
            }));

            for(const descriptor of candidates.slice(0,6)){
              if(cancelled)return false;
              const currentKey=chunkKey(descriptor);

              if(!loadedDetail.has(currentKey)&&!native.hasChunk(currentKey)){
                const objects=await loadGeometryCacheChunk(descriptor);
                if(cancelled)return false;
                if(objects.length){
                  const materialColors=await loadBundleMaterialColors(
                    connection,
                    objects.map(object=>object.objectIndex)
                  );
                  for(const object of objects){
                    if(!object.displayColor){
                      const color=materialColors.get(Number(object.objectIndex));
                      if(color)object.displayColor=color;
                    }
                  }
                  await persistPHDLocalChunkColors(descriptor,objects);
                  native.appendObjects(objects,{fit:false,chunkKey:currentKey});
                  loadedDetail.add(currentKey);
                  native.setSpatialProxyVisible(currentKey,false);
                }
              }

              if(native.hasObject(index)){
                pinnedChunkKey=currentKey;
                spatialState();
                return true;
              }
            }

            // Fallback determinístico: se o índice espacial não localizar o
            // objeto, busca a geometria diretamente no Bundle. Assim um clique
            // na árvore sempre consegue selecionar e enquadrar o item.
            try{
              const direct=await loadBundleGeometryBatch(connection,[index],{
                limit:64,
                maxObjects:1,
                includeMaterialColors:true
              });
              const objects=direct?.objects||[];
              if(objects.length){
                const focusKey='focus:'+String(index);
                native.appendObjects(objects,{fit:false,chunkKey:focusKey});
                for(const object of objects){
                  const objectIndex=Number(object.objectIndex);
                  if(object.displayColor)native.setObjectBaseColor?.(objectIndex,object.displayColor,false);
                  const semanticColor=setColorMapRef.current?.get(objectIndex);
                  if(semanticColor)native.setObjectColor?.(objectIndex,semanticColor,false);
                }
                if(setIsolationRef.current)native.isolateMany?.([...setIsolationRef.current]);
                native.render?.();
                spatialState();
                return native.hasObject(index);
              }
            }catch{}

            spatialState();
            return false;
          }finally{
            spatialBusy=false;
          }
        };

        spatialRuntimeRef.current={
          ensureObjectLoaded,
          auditMissingGeometry:recoverMissingGeometry,
          clearPinned:()=>{pinnedChunkKey=null},
          pinObject:objectIndex=>{
            const exactKey=native.getObjectChunkKey?.(objectIndex);
            pinnedChunkKey=exactKey?.startsWith('detail:')?exactKey:null;
          }
        };

        const prepareLocalVersionCache=async()=>{
          if(runtimeFastReady){
            atomicLocalOpen=true;
            return {ready:true,reused:true};
          }
          if(!renderCacheReady)return {ready:false,reason:'render-cache-missing'};

          try{
            setLoadState(current=>({
              ...current,
              status:'loading',
              progress:1,
              phase:'BAIXANDO MODELO PARA ESTE COMPUTADOR',
              detail:'Primeira abertura desta versão · salvando o modelo completo no cache local para não baixar novamente.',
              localCacheWarming:true,
              localCacheWarmProgress:0,
              atomicLocalOpen:true,
              firstLoadReady:false
            }));

            const hydrated=await hydratePHDLocalCacheFromRenderPacks(chunks,{
              concurrency:16,
              onProgress:info=>{
                if(cancelled)return;
                const pct=Number(info?.progress||0);
                setLoadState(current=>({
                  ...current,
                  status:'loading',
                  progress:Math.max(1,Math.min(72,Math.round(pct*.72))),
                  phase:'BAIXANDO MODELO PARA ESTE COMPUTADOR',
                  detail:Number(info?.processed||0).toLocaleString('pt-BR')+' / '+
                    Number(info?.total||0).toLocaleString('pt-BR')+
                    ' chunks salvos localmente · '+pct+'%',
                  localCacheWarming:true,
                  localCacheWarmProgress:pct,
                  localCacheWarmDetail:
                    Number(info?.written||0).toLocaleString('pt-BR')+' novos · '+
                    Number(info?.existing||0).toLocaleString('pt-BR')+' já locais'
                }));
              }
            });
            if(cancelled)return {ready:false,reason:'cancelled'};
            if(!hydrated.ready)return {ready:false,reason:'hydrate-failed',hydrated};

            const fast=await buildPHDLocalFastCache(cache,chunks,{
              onProgress:info=>{
                if(cancelled)return;
                const pct=Number(info?.progress||0);
                setLoadState(current=>({
                  ...current,
                  status:'loading',
                  progress:72+Math.min(18,Math.round(pct*.18)),
                  phase:'OTIMIZANDO ABERTURA LOCAL',
                  detail:'Criando pacotes rápidos no SSD local · '+
                    Number(info?.processed||0).toLocaleString('pt-BR')+' / '+
                    Number(info?.total||0).toLocaleString('pt-BR'),
                  localCacheWarming:true,
                  localCacheWarmProgress:pct
                }));
              }
            });

            runtimeFastReady=!!fast?.ready;
            runtimeFastPacks=Number(fast?.packs||0);
            atomicLocalOpen=runtimeFastReady;

            const refreshed=await getPHDLocalCacheStatus();
            runtimePersisted=!!refreshed?.persisted;

            setLoadState(current=>({
              ...current,
              status:'loading',
              progress:runtimeFastReady?90:Number(current.progress||0),
              phase:runtimeFastReady?'CACHE LOCAL PRONTO':'CACHE LOCAL PARCIAL',
              detail:runtimeFastReady
                ? 'Download concluído. Montando o modelo completo a partir do SSD local.'
                : 'Não foi possível concluir o Fast Cache; o servidor continuará como fallback.',
              localCacheWarming:false,
              localCacheWarmProgress:runtimeFastReady?100:Number(current.localCacheWarmProgress||0),
              localCacheWarmReady:runtimeFastReady,
              fastCacheReady:runtimeFastReady,
              fastCachePacks:runtimeFastPacks,
              localCachePersisted:runtimePersisted,
              atomicLocalOpen
            }));

            return {ready:runtimeFastReady,hydrated,fast};
          }catch(error){
            if(!cancelled)setLoadState(current=>({
              ...current,
              localCacheWarming:false,
              localCacheWarmError:error?.message||'Falha ao preparar o cache local.'
            }));
            return {ready:false,error};
          }
        };

        // Resolve materiais em paralelo enquanto a geometria é preparada.
        void getVisualAppearance();

        // Com Render Cache disponível, a primeira abertura baixa a versão inteira
        // para o OPFS. A partir da segunda abertura, o version_id encontra o
        // Fast Cache local e nenhuma transferência do modelo é necessária.
        const localVersion=await prepareLocalVersionCache();
        if(cancelled)return;

        if(localVersion.ready){
          atomicLocalOpen=true;
          firstLoadTarget=Math.max(1,selectableChunks.length);

          // Mantém o canvas oculto até que 100% da geometria local esteja na GPU.
          // Assim o usuário vê o modelo completo aparecer de uma única vez.
          await loadAllResidentOptimized();
          if(cancelled)return;

          setLoadState(current=>({
            ...current,
            status:'loading',
            progress:96,
            phase:'APLICANDO MATERIAIS E CORES',
            detail:'Modelo completo montado localmente · finalizando aparência antes de abrir.',
            atomicLocalOpen:true,
            firstLoadReady:false
          }));

          await colorHydrationChain;
          if(cancelled)return;
          const localVisualColors=visualBaseColorMapRef.current||await getVisualAppearance();
          if(localVisualColors?.size){
            native.applyBaseColorMap?.(localVisualColors,{restore:true,render:true});
          }

          appearanceReady=true;
          spatialState();
          setLoadState(current=>({
            ...current,
            status:'ready',
            progress:100,
            phase:'MODELO COMPLETO LOCAL',
            detail:'Versão '+String(connection?.version_id||'')+
              ' aberta do cache local · modelo completo residente na GPU.',
            firstLoadReady:true,
            fullModel:true,
            residentProgress:100,
            atomicLocalOpen:false,
            fastCacheReady:true,
            fastCachePacks:runtimeFastPacks,
            localCacheWarmReady:true
          }));
          requestAnimationFrame(()=>native.renderPremium?.());

          // Auditoria fica em segundo plano e não bloqueia a abertura local.
          void recoverMissingGeometry();
        }else{
          // Fallback para versões antigas/sem Render Cache: mantém abertura
          // progressiva e constrói os artefatos necessários em segundo plano.
          await loadInitialPriority();
          if(cancelled)return;

          setLoadState(current=>({
            ...current,
            status:'loading',
            progress:96,
            phase:'APLICANDO CORES DO VIEWPORT',
            detail:'Resolvendo materiais e cores dos objetos prioritários…'
          }));
          await colorHydrationChain;
          if(cancelled)return;
          const visualColors=visualBaseColorMapRef.current||await getVisualAppearance();
          if(visualColors?.size){
            native.applyBaseColorMap?.(visualColors,{restore:true,render:true});
          }
          appearanceReady=true;
          spatialState();
          requestAnimationFrame(()=>native.renderPremium?.());

          void (async()=>{
            await loadAllResidentOptimized();
            if(cancelled)return;

            await recoverMissingGeometry();
            if(cancelled)return;

            if(cancelled||renderCacheReady)return;

            try{
              const latestCache=await findReadyGeometryCache(connection);
              if(cancelled||!latestCache?.chunks?.length)return;
              setLoadState(current=>({
                ...current,
                renderCacheBuilding:true,
                renderCacheProgress:1,
                renderCacheDetail:'Preparando abertura acelerada para as próximas sessões…'
              }));
              const prepared=await buildHyperViewRenderCache(connection,latestCache,{
                onProgress:info=>{
                  if(cancelled)return;
                  setLoadState(current=>({
                    ...current,
                    renderCacheBuilding:true,
                    renderCacheProgress:Number(info?.progress||0),
                    renderCacheDetail:info?.detail||'Gerando HyperView Render Cache…'
                  }));
                }
              });
              if(cancelled)return;
              setLoadState(current=>({
                ...current,
                renderCacheBuilding:false,
                renderCacheReady:!!prepared,
                renderCacheProgress:prepared?100:current.renderCacheProgress||0,
                renderPackCount:Number(prepared?.pack_count||prepared?.packs?.length||0),
                renderCacheBytes:Number(prepared?.total_bytes||0),
                renderCacheDetail:prepared?'HyperView Render Cache pronto.':''
              }));
              setModelState(current=>({
                ...current,
                renderCacheReady:!!prepared,
                renderPackCount:Number(prepared?.pack_count||prepared?.packs?.length||0),
                renderCacheBytes:Number(prepared?.total_bytes||0)
              }));
            }catch(error){
              if(cancelled)return;
              setLoadState(current=>({
                ...current,
                renderCacheBuilding:false,
                renderCacheError:error?.message||'Render Cache não gerado nesta sessão.'
              }));
            }
          })();
        }

        if(badBoundsChunks.length){
          // Reparação de metadados não pode concorrer com o first paint.
          // Processa poucos chunks por sessão e deixa o restante para acessos futuros.
          void (async()=>{
            await new Promise(resolve=>setTimeout(resolve,3500));
            for(const descriptor of badBoundsChunks.slice(0,8)){
              if(cancelled)return;
              try{
                const objects=await loadGeometryCacheChunk(descriptor);
                if(cancelled)return;
                await repairGeometryCacheChunkBounds(descriptor,objects);
              }catch{}
              await new Promise(resolve=>setTimeout(resolve,220));
            }
            if(!cancelled){
              const refreshedProxy=native.setSpatialProxyBounds(detailChunks.filter(item=>saneBounds(item.bounds)));
              for(const keyValue of loadedDetail)native.setSpatialProxyVisible(keyValue,false);
              if(refreshedProxy?.bounds)globalBoundsRef.current=refreshedProxy.bounds;
            }
          })();
        }

        // O usuário já pode navegar enquanto a residência completa é
        // finalizada em segundo plano. Ao fim, a auditoria tenta recuperar e
        // persistir na Base44 qualquer objeto ausente do cache PHD3D.
      }catch(error){
        fail(error?.message||'Falha ao abrir o PHD3D Spatial v3.');
      }
    };

    void run();
    return()=>{
      cancelled=true;
      spatialRuntimeRef.current=null;
    };
  },[
    native.ready,
    connection?.id,
    connection?.version_id,
    connection?.project_id,
    connection?.model_id,
    setModelState
  ]);

  useEffect(()=>{
    if(!enable4D)return;
    if(simulation.loading)return;
    const initKey=[connection?.id,connection?.version_id].join(':');
    if(fourDInitRef.current===initKey)return;
    fourDInitRef.current=initKey;
    setAuto4D(false);
    fourDColorStateRef.current.clear();
    setFilterState(current=>({...current,colorGroups:0}));
  },[
    simulation.loading,
    simulation.linkedWithGeometryIndex,
    connection?.id,
    connection?.version_id,
    native
  ]);

  useEffect(()=>{
    if(!enable4D)return;
    if(loadState.status!=='ready'||simulation.loading)return;

    const previous=fourDColorStateRef.current;
    const hasLinked4D=Number(simulation.linkedWithGeometryIndex||0)>0;

    if(!auto4D||!hasLinked4D){
      if(previous.size){
        for(const objectIndex of previous.keys()){
          native.restoreObjectColor?.(objectIndex,false);
        }
        previous.clear();
        native.render?.();
      }
      setFilterState(current=>({...current,colorGroups:0}));
      return;
    }

    const next=new Map();
    let activeGroups=0;
    for(const phase of FOUR_D_PHASES){
      let hasResident=false;
      for(const rawIndex of simulation.groupedObjectIndices?.[phase.key]||[]){
        const objectIndex=Number(rawIndex);
        if(!Number.isFinite(objectIndex)||!native.hasObject(objectIndex))continue;
        next.set(objectIndex,phase.color);
        hasResident=true;
      }
      if(hasResident)activeGroups++;
    }

    let changed=false;
    for(const [objectIndex,color] of next){
      if(previous.get(objectIndex)===color)continue;
      changed=native.setObjectColor?.(objectIndex,color,false)||changed;
    }
    for(const objectIndex of previous.keys()){
      if(next.has(objectIndex))continue;
      changed=native.restoreObjectColor?.(objectIndex,false)||changed;
    }

    fourDColorStateRef.current=next;
    if(changed)native.render?.();
    setFilterState(current=>({...current,colorGroups:activeGroups}));
  },[
    auto4D,
    loadState.status,
    loadState.objectCount,
    simulation.loading,
    simulation.date,
    simulation.linkedWithGeometryIndex,
    simulation.groupedObjectIndices
  ]);

  useEffect(()=>{
    bridge.current=async(name,value)=>{
      const target=value?.bundle?value:selected;
      const objectIndex=Number(target?.objectIndex);
      const validObject=Number.isFinite(objectIndex);

      const ensureActive=async()=>{
        if(!validObject)return false;
        if(native.hasObject(objectIndex)){
          spatialRuntimeRef.current?.pinObject?.(objectIndex);
          return true;
        }
        return !!(await spatialRuntimeRef.current?.ensureObjectLoaded?.(objectIndex));
      };

      if(name==='select'){
        onSelected?.(target||null);
        if(!validObject)return;
        if(setIsolationRef.current){
          setIsolationRef.current=null;
          native.restoreVisibility();
        }
        const active=await ensureActive();
        if(active)native.selectObject(objectIndex,{notify:false,focus:true});
        return;
      }
      if(name==='selectSet'){
        const indices=[...new Set((value?.objectIndices||[]).map(Number).filter(Number.isFinite))];
        if(!indices.length)return;
        setIsolationRef.current=new Set(indices);
        setAuto4D(false);

        let active=indices.filter(index=>native.hasObject(index));
        if(active.length<8){
          try{
            const sample=indices.slice(0,48);
            const direct=await loadBundleGeometryBatch(connection,sample,{
              limit:320,
              maxObjects:48,
              includeMaterialColors:true
            });
            const objects=direct?.objects||[];
            if(objects.length){
              native.appendObjects(objects,{fit:false,chunkKey:'set:'+String(value?.nodeId||Date.now())});
              for(const object of objects){
                const index=Number(object.objectIndex);
                if(object.displayColor)native.setObjectBaseColor?.(index,object.displayColor,false);
                if(value?.color)native.setObjectColor?.(index,value.color,false);
              }
              native.render?.();
            }
          }catch{}
          active=indices.filter(index=>native.hasObject(index));
        }

        if(active.length){
          native.isolateMany(active);
          native.fitObjects(active);
          if(value?.color){
            for(const index of active)native.setObjectColor?.(index,value.color,false);
            native.render?.();
          }
        }
        setFilterState(current=>({...current,isolated:active.length,hidden:0}));
        return;
      }
      if(name==='clearSelection'){
        spatialRuntimeRef.current?.clearPinned?.();
        native.clearSelection(true);
        return;
      }
      if(name==='focus'){
        const active=await ensureActive();
        if(active)native.fit(objectIndex);
        else if(!validObject)native.fit();
        return;
      }
      if(name==='fit'){
        spatialRuntimeRef.current?.clearPinned?.();
        globalBoundsRef.current?native.fitBounds(globalBoundsRef.current):native.fit();
        return;
      }
      if(name==='view'){native.setView(String(value||'3d'));return}
      if(name==='projection'){native.toggleProjection();return}
      if(name==='orbit'||name==='pan'||name==='pick'){native.setInteraction(name);return}
      if(name==='section'){native.toggleSection();return}
      if(name==='isolate'){
        const active=await ensureActive();
        if(!active)return;
        native.isolate(objectIndex);
        setFilterState(current=>({...current,isolated:1}));
        return;
      }
      if(name==='hide'){
        const active=await ensureActive();
        if(!active)return;
        native.hide(objectIndex);
        setFilterState(current=>({...current,hidden:current.hidden+1}));
        return;
      }
      if(name==='show'){
        const active=await ensureActive();
        if(active)native.show(objectIndex);
        return;
      }
      if(name==='restore'){
        setIsolationRef.current=null;
        native.restoreVisibility();
        setFilterState({hidden:0,isolated:0,colorGroups:filterState.colorGroups});
        return;
      }
      if(name==='renderMode'){
        native.setRenderMode(String(value||'solid'));
        return;
      }
      if(name==='modelVisible'){
        native.setModelVisible(value!==false);
        return;
      }
      if(name==='opacity'){
        const raw=Number(value);
        native.setGlobalOpacity(raw>1?raw/100:raw);
        return;
      }
      if(name==='originalColors'){
        setAuto4D(false);
        setColorMapRef.current=null;
        try{
          let colors=visualBaseColorMapRef.current;
          if(!colors?.size){
            const original=await loadBundleMaterialColorMap(connection);
            if(original?.size)originalColorMapRef.current=original;
            const visual=new Map(original?.size?original:[]);
            const groups=await loadBundleCollectionGroups(connection).catch(()=>[]);
            for(const group of groups||[]){
              const fallback=semanticColorForName(group?.name);
              for(const rawIndex of group?.objectIndices||[]){
                const objectIndex=Number(rawIndex);
                if(Number.isFinite(objectIndex)&&!visual.has(objectIndex))visual.set(objectIndex,fallback);
              }
            }
            visualBaseColorMapRef.current=visual;
            colors=visual;
          }
          if(colors?.size)native.applyBaseColorMap?.(colors,{restore:true,render:true});
          else native.clearColors();
          setFilterState(current=>({...current,colorGroups:0}));
        }catch{
          native.clearColors();
          setFilterState(current=>({...current,colorGroups:0}));
        }
        return;
      }
      if(name==='colorBySets'){
        setAuto4D(false);
        if(value===false){
          setColorMapRef.current=null;
          const visual=visualBaseColorMapRef.current||originalColorMapRef.current;
          if(visual?.size)native.applyBaseColorMap?.(visual,{restore:true,render:true});
          else native.clearColors();
          setFilterState(current=>({...current,colorGroups:0}));
          return;
        }
        try{
          const groups=await loadBundleCollectionGroups(connection);
          const colorGroups=(groups||[]).map((group,index)=>({
            objectIndices:group.objectIndices||[],
            color:SET_PALETTE[index%SET_PALETTE.length],
            label:group.name
          }));
          const map=new Map();
          for(const group of colorGroups){
            for(const rawIndex of group.objectIndices){
              const index=Number(rawIndex);
              if(Number.isFinite(index))map.set(index,group.color);
            }
          }
          setColorMapRef.current=map;
          native.applyColorGroups(colorGroups);
          setFilterState(current=>({...current,colorGroups:colorGroups.length}));
        }catch{}
        return;
      }
      if(name==='color4d'){
        const active=await ensureActive();
        if(!active)return;
        setAuto4D(false);
        native.setObjectColor(objectIndex,typeof value==='string'?value:String(value?.color||'#9aa7b4'));
        setFilterState(current=>({...current,colorGroups:1}));
        return;
      }
      if(name==='clearColors'){
        setAuto4D(false);
        setColorMapRef.current=null;
        const visual=visualBaseColorMapRef.current||originalColorMapRef.current;
        if(visual?.size)native.applyBaseColorMap?.(visual,{restore:true,render:true});
        else native.clearColors();
        setFilterState(current=>({...current,colorGroups:0}));
        return;
      }
      if(name==='toggle4d'){
        if(Number(simulation.linkedWithGeometryIndex||0)<=0){
          setAuto4D(false);
          native.clearColors();
          setFilterState(current=>({...current,colorGroups:0}));
          return;
        }
        setAuto4D(current=>!current);
        return;
      }
      if(name==='showAll'){
        spatialRuntimeRef.current?.clearPinned?.();
        setIsolationRef.current=null;
        native.restoreVisibility();
        setFilterState({hidden:0,isolated:0,colorGroups:filterState.colorGroups});
        globalBoundsRef.current?native.fitBounds(globalBoundsRef.current):native.fit();
        return;
      }
      if(name==='screenshot'){
        native.captureScreenshot?.('PHD360-'+String(connection?.model_name||'modelo').replace(/[^a-z0-9_-]+/gi,'-')+'.png');
      }
    };
    return()=>{bridge.current=null};
  },[bridge,selected,native,onSelected,filterState.colorGroups,simulation.linkedWithGeometryIndex,connection?.model_name]);

  if(!viewerUrl)return <div className="bundle-viewer-error"><strong>Modelo Speckle não configurado</strong><span>Selecione projeto, modelo e versão em Configurações.</span></div>;

  const loading=loadState.status==='loading'||!native.ready;
  const needsPreparation=loadState.status==='needs-preparation';
  const error=loadState.status==='error'||native.status==='error';
  const progress=Math.max(0,Math.min(100,Number(loadState.progress||0)));
  const hasRenderableModel=Number(loadState.objectCount||0)>0;
  const blockingModelLoad=!error&&!needsPreparation&&!loadState.firstLoadReady;
  const fromNetwork=Number(loadState.networkChunks||0)>0;
  const displayProgress=progress>0?Math.max(1,progress):0;

  return <div className={'bundle-viewer-shell bundle-local-stage '+(blockingModelLoad?'model-is-loading':'model-is-ready')}>
    <div ref={host} className={'bundle-local-host phd-native-host '+(blockingModelLoad?'phd-model-concealed':'')} id="phd-native-viewer-host"/>

    {error&&<div className="bundle-local-runtime-state error">
      <TriangleAlert size={18}/>
      <div><strong>FALHA NO CARREGAMENTO DO MODELO</strong><span>{loadState.error||native.error}</span></div>
    </div>}

    {blockingModelLoad&&<div className="model-blocking-load" aria-live="polite">
      <div className="model-blocking-load-card">
        <div className="model-blocking-load-title">
          {fromNetwork?<CloudDownload size={18}/>:<Loader2 size={18} className="animate-spin"/>}
          <div>
            <strong>ABRINDO PHD HYPERVIEW</strong>
            <span>{connection?.model_name||connection?.name||'Modelo 3D'}</span>
          </div>
          <b>{displayProgress}%</b>
        </div>
        <div className="model-blocking-load-track"><i style={{width:displayProgress+'%'}}/></div>
        <div className="model-blocking-load-meta">
          <span>BASE {Number(loadState.serverCachedChunks||0).toLocaleString('pt-BR')} / {Number(loadState.serverTotalChunks||0).toLocaleString('pt-BR')} ✓</span>
          <span>VIEWPORT {Number(loadState.activeChunks||0).toLocaleString('pt-BR')} / {Number(loadState.firstLoadTarget||0).toLocaleString('pt-BR')} chunks</span>
          <span>{Number(loadState.objectCount||0).toLocaleString('pt-BR')} objetos na GPU</span>
          <span>LOCAL {Number(loadState.localChunks||0).toLocaleString('pt-BR')}</span>
          <span>REDE {Number(loadState.networkChunks||0).toLocaleString('pt-BR')}</span>
          <span>CORES {Number(loadState.coloredObjectCount||0).toLocaleString('pt-BR')}</span>
        </div>
        <small>{progress>=92&&!loadState.appearanceReady
          ? 'Visão geral pronta. Aplicando cores e materiais antes de liberar a navegação.'
          : 'O modelo já está 100% preparado na Base44; esta barra mostra apenas a montagem do viewport na GPU.'}</small>
      </div>
    </div>}

    {needsPreparation&&<div className="bundle-local-runtime-state cache-required">
      <DatabaseZap size={21}/>
      <div>
        <strong>MODELO 3D AINDA NÃO PREPARADO</strong>
        <span>Esta versão precisa ser preparada no formato espacial atual.</span>
        <p>Execute a preparação uma única vez. Depois o viewer manterá somente os chunks relevantes para a câmera na GPU.</p>
        <button className="primary-action" onClick={()=>navigate('/configuracoes')}><Settings2 size={14}/>Preparar modelo 3D</button>
      </div>
    </div>}

    {hasRenderableModel&&<div className={'native-viewer-ready '+(!loadState.fullModel?'streaming':'')}>
      <CheckCircle2 size={12}/>
      <span>PHD HYPERVIEW · {loadState.fullModel?'MODELO COMPLETO':'CARREGANDO MODELO COMPLETO'}</span>
      <b>{Number(loadState.activeChunks||0).toLocaleString('pt-BR')} / {Number(loadState.totalSpatialChunks||0).toLocaleString('pt-BR')} CHUNKS RESIDENTES · {Number(loadState.residentProgress||0)}%</b>
      <em>{Number(loadState.objectCount||0).toLocaleString('pt-BR')} OBJETOS 3D NO VIEWER</em>
      <em>{Number(loadState.totalObjects||0).toLocaleString('pt-BR')} PREPARADOS NA BASE · OPFS {loadState.fastCacheReady?'FAST':loadState.localCacheWarming?'AQUECENDO '+Number(loadState.localCacheWarmProgress||0)+'%':'PENDENTE'}</em>
      {(Number(loadState.ttfpMs||0)>0||Number(loadState.ttiMs||0)>0)&&<em>TTFP {(Number(loadState.ttfpMs||0)/1000).toFixed(1)}s · TTI {(Number(loadState.ttiMs||0)/1000).toFixed(1)}s · CACHE {Number(loadState.cacheHitRatio||0)}%</em>}
      {Number(loadState.recoveryMissingCount||0)>0&&<em>RECUPERADOS {Number(loadState.recoveredObjectCount||0).toLocaleString('pt-BR')} · SEM MALHA {Number(loadState.recoveryUnresolvedCount||0).toLocaleString('pt-BR')}</em>}
    </div>}

    {hasRenderableModel&&(filterState.hidden>0||filterState.isolated>0||filterState.colorGroups>0)&&<div className="bundle-filter-state">
      <PlayCircle size={11}/>
      <span>OCULTOS {filterState.hidden}</span>
      <span>ISOLADOS {filterState.isolated}</span>
      <span>CORES 4D {filterState.colorGroups}</span>
    </div>}

    {hasRenderableModel&&<div className="bundle-viewer-badge">
      <Cpu size={11}/>
      <span>PHD HYPERVIEW · FLOATING ORIGIN · ADAPTIVE LOD</span>
      <a href={viewerUrl} target="_blank" rel="noreferrer">Fonte Speckle <ExternalLink size={11}/></a>
    </div>}
  </div>;
}
