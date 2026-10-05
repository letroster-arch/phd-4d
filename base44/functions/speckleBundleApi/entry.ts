import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import { waitUntil } from 'base44:runtime';
import * as THREE from 'npm:three@0.171.0';
import { speckleOrigin, speckleHeaders } from '../../shared/speckleGateway.ts';

type AnyRow = Record<string, any>;
type RemoteFile = { byteLength:number; slice:(start:number,end?:number)=>Promise<ArrayBuffer> };

const artifactCache=new Map<string,{at:number,data:any}>();
const objectCache=new Map<string,AnyRow[]>();
const pathCache=new Map<string,{pathMap:Map<number,string>}>();
const materialColorCache=new Map<string,{at:number,colors:Map<number,string>}>();
const collectionGroupCache=new Map<string,{at:number,groups:any[]}>();
const collectionObjectIndexCache=new Map<string,{at:number,objectIndices:number[],descendantCollections:number}>();
const fullFileCache=new Map<string,{at:number,bytes:Uint8Array}>();
const phdDefinitionGeometryCache=new Map<string,Promise<Map<number,number[]>>>();

const textDecoder=new TextDecoder();
const decodeText=(v:any)=>{
  if(typeof v==='string')return v;
  if(v instanceof Uint8Array)return textDecoder.decode(v);
  if(v?.buffer instanceof ArrayBuffer)return textDecoder.decode(new Uint8Array(v.buffer,v.byteOffset||0,v.byteLength||v.length||0));
  return String(v||'');
};
const toBytes=(input:any)=>{
  if(input instanceof Uint8Array)return input;
  if(input instanceof ArrayBuffer)return new Uint8Array(input);
  if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  if(Array.isArray(input))return Uint8Array.from(input);
  if(input?.buffer instanceof ArrayBuffer)return new Uint8Array(input.buffer,input.byteOffset||0,input.byteLength||input.length||0);
  return new Uint8Array(input||[]);
};
const clean=(v:any)=>String(v??'').trim();
const norm=(v:any)=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const valueOf=(r:any)=>r?.value_string??r?.value_double??r?.value_int??r?.value_integer??r?.value_long??r?.value_boolean??null;
const json=(data:any,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});

async function parquetLib(){
  const [hp,fzstd]=await Promise.all([
    import('npm:hyparquet@1.31.1'),
    import('npm:fzstd@0.1.1')
  ]);
  const rawZstd=fzstd.decompress;
  const asBytes=(input:any)=>{
    if(input instanceof Uint8Array)return input;
    if(input instanceof ArrayBuffer)return new Uint8Array(input);
    if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
    if(Array.isArray(input))return Uint8Array.from(input);
    if(input?.buffer instanceof ArrayBuffer)return new Uint8Array(input.buffer,input.byteOffset||0,input.byteLength||input.length||undefined);
    throw new Error(`ZSTD recebeu tipo inválido: ${Object.prototype.toString.call(input)}`);
  };
  const compressors={
    ZSTD:(input:any)=>{
      const bytes=asBytes(input);
      const result=rawZstd(bytes);
      return result instanceof Uint8Array?result:asBytes(result);
    }
  };
  if(typeof rawZstd!=='function')throw new Error('Descompressor ZSTD JS não carregado no runtime.');
  return {parquetReadObjects:hp.parquetReadObjects,parquetMetadataAsync:hp.parquetMetadataAsync,compressors};
}
async function resolveConnection(base44:any,body:any){
  const supplied=body.connection&&typeof body.connection==='object'?body.connection:null;
  if(supplied?.project_id&&supplied?.model_id&&supplied?.version_id)return supplied;
  if(!body.connectionId)throw new Error('Conexão Speckle não selecionada.');
  const c=await base44.entities.SpeckleConnection.get(String(body.connectionId));
  if(!c)throw new Error('Conexão Speckle não encontrada.');
  return c;
}
function cacheKey(c:any){return [c.project_id,c.model_id,c.version_id].join(':')}
async function artifacts(c:any){
  if(c.server_url&&c.server_url!==speckleOrigin)throw new Error('Servidor Speckle não autorizado.');
  const key=cacheKey(c),hit=artifactCache.get(key);
  if(hit&&Date.now()-hit.at<30*60*1000)return hit.data;
  const url=`${speckleOrigin}/api/v2/projects/${c.project_id}/models/${c.model_id}/versions/${c.version_id}/artifacts`;
  const res=await fetch(url,{headers:speckleHeaders(true),signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw new Error(`Speckle artifacts HTTP ${res.status}. Verifique token, projeto, modelo e versão.`);
  const data=await res.json();
  if(!Array.isArray(data?.files))throw new Error('Speckle não retornou a lista de artifacts.');
  artifactCache.set(key,{at:Date.now(),data});
  return data;
}
function artifact(data:any,suffix:string){
  const f=(data.files||[]).find((x:any)=>String(x.name||'').endsWith(suffix));
  if(!f?.url)throw new Error('Artifact ausente: '+suffix);
  return f;
}
async function remote(file:any):Promise<RemoteFile>{
  const url=String(file?.url||'');
  if(!url)throw new Error('Artifact sem URL assinada.');
  const cached=fullFileCache.get(url);
  if(cached&&Date.now()-cached.at<20*60*1000){
    const bytes=cached.bytes;
    return {byteLength:bytes.byteLength,async slice(start:number,end?:number){
      const part=bytes.slice(start,end??bytes.byteLength);
      return part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength);
    }};
  }
  const request=async(headers:Record<string,string>={})=>{
    let res=await fetch(url,{headers,signal:AbortSignal.timeout(60000)});
    if((res.status===401||res.status===403)&&!res.ok){
      res=await fetch(url,{headers:{...speckleHeaders(true),...headers},signal:AbortSignal.timeout(60000)});
    }
    return res;
  };
  const range=await request({Range:'bytes=0-0'});
  if(range.ok){
    const match=(range.headers.get('content-range')||'').match(/\/(\d+)$/);
    const length=Number(match?.[1]||range.headers.get('content-length')||0);
    if(length){
      return {byteLength:length,async slice(start:number,end?:number){
        const last=Math.max(start,(end??length)-1);
        const res=await request({Range:`bytes=${start}-${last}`});
        if(res.ok)return res.arrayBuffer();
        if(res.status!==400&&res.status!==416)throw new Error(`Parquet range HTTP ${res.status}.`);
        const full=await request();
        if(!full.ok)throw new Error(`Artifact HTTP ${full.status}.`);
        const buffer=await full.arrayBuffer();
        if(buffer.byteLength>160*1024*1024)throw new Error('Artifact muito grande para fallback sem Range.');
        const bytes=new Uint8Array(buffer);fullFileCache.set(url,{at:Date.now(),bytes});
        const part=bytes.slice(start,end??bytes.byteLength);
        return part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength);
      }};
    }
  }
  if(range.status!==400&&range.status!==416)throw new Error(`Artifact range HTTP ${range.status}.`);
  const full=await request();
  if(!full.ok)throw new Error(`Artifact HTTP ${full.status}.`);
  const buffer=await full.arrayBuffer();
  if(buffer.byteLength>160*1024*1024)throw new Error('Artifact não aceita Range e excede 160 MB; use EAV/SDK para este arquivo.');
  const bytes=new Uint8Array(buffer);fullFileCache.set(url,{at:Date.now(),bytes});
  return {byteLength:bytes.byteLength,async slice(start:number,end?:number){
    const part=bytes.slice(start,end??bytes.byteLength);
    return part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength);
  }};
}
async function parquet(data:any,suffix:string){return remote(artifact(data,suffix))}
async function objects(c:any,data:any){
  const key=cacheKey(c);if(objectCache.has(key))return objectCache.get(key)!;
  const {parquetReadObjects,compressors}=await parquetLib();
  const rows=await parquetReadObjects({file:await parquet(data,'.eav.objects.parquet'),columns:['object_index','application_id'],compressors});
  objectCache.set(key,rows);return rows;
}
async function paths(c:any,data:any){
  const key=cacheKey(c);if(pathCache.has(key))return pathCache.get(key)!;
  const {parquetReadObjects,compressors}=await parquetLib();
  const rows=await parquetReadObjects({file:await parquet(data,'.eav.paths.parquet'),compressors});
  const result={pathMap:new Map<number,string>(rows.map((x:any)=>[Number(x.path_index),String(x.path)]))};
  pathCache.set(key,result);return result;
}
function normalizeColor(value:any){
  if(value===null||value===undefined)return null;
  if(typeof value==='number'||/^[-+]?\d+$/.test(String(value).trim())){
    const n=Number(value);
    if(!Number.isFinite(n))return null;
    const argb=(Math.trunc(n)>>>0);
    const rgb=argb&0x00ffffff;
    return '#'+rgb.toString(16).padStart(6,'0');
  }
  const raw=String(value).trim();
  const hex=raw.match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if(hex){
    const h=hex[1].toLowerCase();
    return '#'+(h.length===8?h.slice(2):h);
  }
  const ox=raw.match(/^0x([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if(ox){
    const h=ox[1].toLowerCase();
    return '#'+(h.length===8?h.slice(2):h);
  }
  const rgb=raw.match(/(?:rgb\s*\()?\s*(\d{1,3})\s*[,; ]\s*(\d{1,3})\s*[,; ]\s*(\d{1,3})\s*\)?/i);
  if(rgb){
    const parts=rgb.slice(1,4).map(x=>Math.max(0,Math.min(255,Number(x))));
    return '#'+parts.map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  return null;
}

function colorPathPriority(path:string){
  const p=norm(path);
  if(/rendermaterial.*diffuse/.test(p))return 100;
  if(/display.*colou?r/.test(p))return 95;
  if(/material.*diffuse/.test(p))return 90;
  if(/(^|\.)diffuse$/.test(p))return 85;
  if(/(^|\.)(argb|rgba)$/.test(p))return 80;
  if(/(^|\.)(color|colour)$/.test(p))return 70;
  return 0;
}

function relationCatalogFile(data:any){
  const files=data?.files||[];
  // Bundle spec 1.2 / Speckle 2026.9: {base}.envelope.rel_types.parquet.
  // O matcher anterior procurava "relation_types" e por isso nunca abria o
  // catálogo real — resultado: geometria correta, aparência vazia/cinza.
  return files.find((f:any)=>String(f?.name||'').toLowerCase().endsWith('.envelope.rel_types.parquet'))
    ||files.find((f:any)=>{
      const name=String(f?.name||'').toLowerCase();
      return /(^|[._-])rel[_-]?types([._-]|$)/.test(name)
        ||/relation[_\-. ]?types/.test(name)
        ||/relations[_\-. ]?catalog/.test(name);
    })
    ||null;
}

function relationAppearancePriority(name:string){
  switch(String(name||'').toUpperCase()){
    // Material é intrínseco: geometria vence o fill de objeto.
    case 'HAS_MATERIAL': return 150;
    case 'OBJECT_HAS_MATERIAL': return 140;
    case 'NODE_HAS_MATERIAL': return 110;
    // Cor é presentacional: objeto vence geometria/container.
    case 'OBJECT_HAS_COLOR': return 170;
    case 'HAS_COLOR': return 160;
    case 'NODE_HAS_COLOR': return 120;
    default:return 0;
  }
}

function rowNumber(row:any,keys:string[]){
  for(const key of keys){
    const value=Number(row?.[key]);
    if(Number.isFinite(value))return value;
  }
  return null;
}

function rowText(row:any,keys:string[]){
  for(const key of keys){
    const value=row?.[key];
    if(value!==null&&value!==undefined&&String(value).trim())return String(value);
  }
  return '';
}

function nodeAppearanceColor(row:any){
  const candidates=[
    row?.argb,row?.diffuse,row?.color,row?.colour,row?.rgba,
    row?.material_argb,row?.display_color,row?.display_colour,
    row?.value_int,row?.value_integer,row?.value_long,row?.value_string
  ];
  for(const value of candidates){
    const color=normalizeColor(value);
    if(color)return color;
  }
  return null;
}

/**
 * Bundle 2026.9+ não armazena aparência como uma propriedade simples do
 * objeto. Materiais/cores são nós do envelope ligados por relações tipadas
 * (HAS_MATERIAL / *_HAS_COLOR). O viewer oficial resolve "effective_material"
 * dessa forma. Este resolver reproduz a mesma ideia no renderer PHD e mantém
 * fallback para versões antigas que ainda materializam diffuse/color no EAV.
 */
async function graphAppearanceColors(data:any){
  const catalogFile=relationCatalogFile(data);
  if(!catalogFile)return new Map<number,{priority:number,color:string}>();

  const {parquetReadObjects,compressors}=await parquetLib();
  let catalogRows:any[]=[];
  try{
    catalogRows=await parquetReadObjects({file:await remote(catalogFile),compressors});
  }catch{
    return new Map<number,{priority:number,color:string}>();
  }

  const relIds=new Map<number,{name:string,priority:number}>();
  for(const row of catalogRows){
    const id=rowNumber(row,['id','rel','relation_type','relation_type_id','k','code']);
    const name=rowText(row,['name','type','label','relation','relation_name','rel_name']).toUpperCase();
    if(id===null||!name)continue;
    const priority=relationAppearancePriority(name);
    if(priority>0)relIds.set(id,{name,priority});
  }
  if(!relIds.size)return new Map<number,{priority:number,color:string}>();

  const relationsFile=await parquet(data,'.envelope.relations.parquet');
  const nodesFile=await parquet(data,'.envelope.nodes.parquet');
  let appearanceEdges:any[]=[];
  try{
    appearanceEdges=await parquetReadObjects({
      file:relationsFile,
      columns:['rel','src','dst','ord'],
      compressors,
      filter:{rel:{$in:[...relIds.keys()]}},
      usePageIndex:true,
      useBloomFilters:true
    });
  }catch{
    return new Map<number,{priority:number,color:string}>();
  }
  if(!appearanceEdges.length)return new Map<number,{priority:number,color:string}>();

  const targetIds=[...new Set(appearanceEdges.map(row=>Number(row.dst)).filter(Number.isFinite))];
  let appearanceNodes:any[]=[];
  try{
    // O conjunto de materiais/cores costuma ser muito menor que o modelo.
    // Ler todas as colunas somente desses nós permite acompanhar mudanças do
    // schema Bundle sem hardcode de cada versão.
    appearanceNodes=await parquetReadObjects({
      file:nodesFile,
      compressors,
      filter:{id:{$in:targetIds}},
      usePageIndex:true,
      useBloomFilters:true
    });
  }catch{
    return new Map<number,{priority:number,color:string}>();
  }

  const colorByNode=new Map<number,string>();
  for(const row of appearanceNodes){
    const id=Number(row.id);
    const color=nodeAppearanceColor(row);
    if(Number.isFinite(id)&&color)colorByNode.set(id,color);
  }
  if(!colorByNode.size)return new Map<number,{priority:number,color:string}>();

  // Relações DISPLAY/SOLID ligam object_index à geometryIndex. Lemos
  // apenas geometrias que realmente têm aparência para evitar varrer milhões
  // de arestas em modelos grandes.
  const appearanceSources=[...new Set(
    appearanceEdges.map(row=>Number(row.src)).filter(Number.isFinite)
  )];
  let ownerRows:any[]=[];
  try{
    ownerRows=await parquetReadObjects({
      file:relationsFile,
      columns:['rel','src','dst'],
      compressors,
      filter:{$and:[
        {rel:{$in:[1,2]}},
        {dst:{$in:appearanceSources}}
      ]},
      usePageIndex:true,
      useBloomFilters:true
    });
  }catch{}

  const ownersByGeometry=new Map<number,number[]>();
  const addGeometryOwner=(geometry:number,owner:number)=>{
    if(!Number.isFinite(owner)||!Number.isFinite(geometry))return;
    const owners=ownersByGeometry.get(geometry)||[];
    if(!owners.includes(owner))owners.push(owner);
    ownersByGeometry.set(geometry,owners);
  };
  for(const row of ownerRows){
    addGeometryOwner(Number(row.dst),Number(row.src));
  }

  // Instâncias: object --rel8--> instance node --def_ref--> definition
  //              definition --rel4--> geometry
  // Sem esta etapa blocos/instâncias perdiam a aparência e caíam no cinza.
  try{
    if(appearanceSources.length){
      const definitionGeometryRows=await parquetReadObjects({
        file:relationsFile,
        columns:['rel','src','dst'],
        compressors,
        filter:{$and:[
          {rel:{$eq:4}},
          {dst:{$in:appearanceSources}}
        ]},
        usePageIndex:true,
        useBloomFilters:true
      });

      const definitionIds=[...new Set(
        definitionGeometryRows.map(row=>Number(row.src)).filter(Number.isFinite)
      )];

      if(definitionIds.length){
        const instanceNodes=await parquetReadObjects({
          file:nodesFile,
          columns:['id','def_ref'],
          compressors,
          filter:{def_ref:{$in:definitionIds}},
          usePageIndex:true,
          useBloomFilters:true
        });
        const definitionByNode=new Map<number,number>();
        for(const row of instanceNodes){
          const nodeId=Number(row.id),definition=Number(row.def_ref);
          if(Number.isFinite(nodeId)&&Number.isFinite(definition)){
            definitionByNode.set(nodeId,definition);
          }
        }

        const nodeIds=[...definitionByNode.keys()];
        if(nodeIds.length){
          const instanceOwnerRows=await parquetReadObjects({
            file:relationsFile,
            columns:['rel','src','dst'],
            compressors,
            filter:{$and:[
              {rel:{$eq:8}},
              {dst:{$in:nodeIds}}
            ]},
            usePageIndex:true,
            useBloomFilters:true
          });

          const ownersByDefinition=new Map<number,number[]>();
          for(const row of instanceOwnerRows){
            const owner=Number(row.src),nodeId=Number(row.dst);
            const definition=definitionByNode.get(nodeId);
            if(!Number.isFinite(owner)||!Number.isFinite(definition))continue;
            const owners=ownersByDefinition.get(definition)||[];
            if(!owners.includes(owner))owners.push(owner);
            ownersByDefinition.set(definition,owners);
          }

          for(const row of definitionGeometryRows){
            const definition=Number(row.src),geometry=Number(row.dst);
            for(const owner of ownersByDefinition.get(definition)||[]){
              addGeometryOwner(geometry,owner);
            }
          }
        }
      }
    }
  }catch(error){
    console.warn('instance appearance propagation fallback',error instanceof Error?error.message:String(error));
  }

  const best=new Map<number,{priority:number,color:string}>();
  const assign=(objectIndex:number,priority:number,color:string)=>{
    if(!Number.isFinite(objectIndex))return;
    const current=best.get(objectIndex);
    if(!current||priority>current.priority)best.set(objectIndex,{priority,color});
  };

  for(const edge of appearanceEdges){
    const rel=Number(edge.rel),src=Number(edge.src),dst=Number(edge.dst);
    const relation=relIds.get(rel);
    const color=colorByNode.get(dst);
    if(!relation||!color||!Number.isFinite(src))continue;

    // OBJECT_HAS_* usa o object_index diretamente. HAS_MATERIAL/HAS_COLOR
    // costuma apontar para geometryIndex; quando houver owner, propaga.
    if(relation.name.includes('OBJECT_'))assign(src,relation.priority,color);
    const owners=ownersByGeometry.get(src);
    if(owners?.length){
      for(const owner of owners)assign(owner,relation.priority,color);
    }else if(!relation.name.includes('OBJECT_')){
      // Fallback seguro para bundles onde src já é o object_index.
      assign(src,relation.priority-4,color);
    }
  }

  return best;
}

function valuesFromTargetField(value:any){
  if(value===null||value===undefined)return [];
  if(Array.isArray(value))return value.flatMap(valuesFromTargetField);
  if(typeof value==='number')return [value];
  if(typeof value==='object'){
    return Object.values(value).flatMap(valuesFromTargetField);
  }
  const raw=String(value).trim();
  if(!raw)return [];
  try{
    const parsed=JSON.parse(raw);
    if(parsed!==raw)return valuesFromTargetField(parsed);
  }catch{}
  if(raw.includes(',')||raw.includes(';')){
    return raw.split(/[,;]+/).map(v=>v.trim()).filter(Boolean);
  }
  return [raw];
}

async function proxyAppearanceColors(c:any,data:any){
  const {parquetReadObjects,compressors}=await parquetLib();
  const {pathMap}=await paths(c,data);
  const typePaths=[...pathMap.entries()]
    .filter(([,path])=>norm(path).endsWith('speckle_type'))
    .map(([pathIndex])=>pathIndex);
  if(!typePaths.length)return new Map<number,{priority:number,color:string}>();

  const eavFile=await parquet(data,'.eav.eav.parquet');
  let typeRows:any[]=[];
  try{
    typeRows=await parquetReadObjects({
      file:eavFile,
      compressors,
      filter:{path_index:{$in:typePaths}},
      usePageIndex:true,
      useBloomFilters:true
    });
  }catch{
    return new Map<number,{priority:number,color:string}>();
  }

  const proxyIndices:number[]=[];
  const proxyKind=new Map<number,string>();
  for(const row of typeRows){
    const index=Number(row.object_index);
    const type=norm(valueOf(row));
    if(!Number.isFinite(index))continue;
    if(type.includes('rendermaterialproxy')){
      proxyIndices.push(index);proxyKind.set(index,'material');
    }else if(type.includes('colorproxy')||type.includes('colourproxy')){
      proxyIndices.push(index);proxyKind.set(index,'color');
    }
  }
  if(!proxyIndices.length)return new Map<number,{priority:number,color:string}>();

  const proxyPathEntries=[...pathMap.entries()].filter(([,path])=>{
    const p=norm(path);
    return p.includes('objects')||
      p.includes('value.diffuse')||
      p.includes('value.color')||
      p.includes('value.colour')||
      p.endsWith('.value')||
      p==='value'||
      p.includes('source');
  });
  if(!proxyPathEntries.length)return new Map<number,{priority:number,color:string}>();

  const proxyPathIndices=proxyPathEntries.map(([pathIndex])=>pathIndex);
  const pathByIndex=new Map(proxyPathEntries.map(([pathIndex,path])=>[pathIndex,norm(path)]));
  let rows:any[]=[];
  try{
    rows=await parquetReadObjects({
      file:eavFile,
      compressors,
      filter:{$and:[
        {object_index:{$in:proxyIndices}},
        {path_index:{$in:proxyPathIndices}}
      ]},
      usePageIndex:true,
      useBloomFilters:true
    });
  }catch{
    return new Map<number,{priority:number,color:string}>();
  }

  const payload=new Map<number,{color:string|null,targets:any[],source:string}>();
  for(const row of rows){
    const index=Number(row.object_index),path=pathByIndex.get(Number(row.path_index))||'';
    if(!Number.isFinite(index))continue;
    const item=payload.get(index)||{color:null,targets:[],source:''};
    const value=valueOf(row);

    if(path.includes('objects')){
      item.targets.push(...valuesFromTargetField(value));
    }else if(path.includes('source')){
      item.source=String(value??'');
    }else{
      const color=normalizeColor(value);
      if(color){
        const kind=proxyKind.get(index);
        const preferred=kind==='material'
          ? path.includes('diffuse')||path.includes('color')||path.includes('colour')
          : path.endsWith('.value')||path==='value'||path.includes('color')||path.includes('colour');
        if(preferred||!item.color)item.color=color;
      }
    }
    payload.set(index,item);
  }

  const objectRows=await objects(c,data);
  const byApplicationId=new Map<string,number>();
  for(const row of objectRows){
    const objectIndex=Number(row.object_index);
    const applicationId=String(row.application_id??'').trim();
    if(applicationId&&Number.isFinite(objectIndex))byApplicationId.set(applicationId,objectIndex);
  }

  const result=new Map<number,{priority:number,color:string}>();
  const assign=(objectIndex:number,color:string,priority:number)=>{
    if(!Number.isFinite(objectIndex)||!color)return;
    const current=result.get(objectIndex);
    if(!current||priority>current.priority)result.set(objectIndex,{priority,color});
  };

  for(const [proxyIndex,item] of payload){
    if(!item.color||!item.targets.length)continue;
    const kind=proxyKind.get(proxyIndex);
    const priority=kind==='material'?145:140;
    for(const rawTarget of item.targets){
      const numeric=Number(rawTarget);
      if(Number.isFinite(numeric)&&String(rawTarget).trim()!==''){
        // Alguns exporters serializam o alvo como object_index.
        assign(numeric,item.color,priority);
      }
      const applicationId=String(rawTarget??'').trim();
      const mapped=byApplicationId.get(applicationId);
      if(Number.isFinite(mapped))assign(mapped,item.color,priority);
    }
  }
  return result;
}

async function materialColors(c:any,data:any){
  const key=cacheKey(c)+'|appearance-v4',hit=materialColorCache.get(key);
  if(hit&&Date.now()-hit.at<30*60*1000)return hit.colors;

  const colors=new Map<number,string>();
  const best=new Map<number,{priority:number,color:string}>();

  // 1) Navisworks/Revit e outros exporters podem publicar a aparência
  // através de RenderMaterialProxy/ColorProxy. É a mesma semântica usada pelo
  // viewer oficial e tem prioridade sobre o fallback genérico.
  try{
    const proxies=await proxyAppearanceColors(c,data);
    for(const [objectIndex,item] of proxies)best.set(objectIndex,item);
  }catch(error){
    console.warn('proxyAppearanceColors fallback',error instanceof Error?error.message:String(error));
  }

  // 2) Bundle novo: relações tipadas do envelope.
  try{
    const graph=await graphAppearanceColors(data);
    for(const [objectIndex,item] of graph){
      const current=best.get(objectIndex);
      if(!current||item.priority>current.priority)best.set(objectIndex,item);
    }
  }catch(error){
    console.warn('graphAppearanceColors fallback',error instanceof Error?error.message:String(error));
  }

  // 3) Fallback/compatibilidade: propriedades de cor materializadas no EAV.
  try{
    const {parquetReadObjects,compressors}=await parquetLib();
    const {pathMap}=await paths(c,data);
    const candidates=[...pathMap.entries()]
      .map(([pathIndex,path])=>({pathIndex,path,priority:colorPathPriority(path)}))
      .filter(item=>item.priority>0);

    if(candidates.length){
      const priorityByPath=new Map(candidates.map(item=>[item.pathIndex,item.priority]));
      const rows=await parquetReadObjects({
        file:await parquet(data,'.eav.eav.parquet'),
        compressors,
        filter:{path_index:{$in:candidates.map(item=>item.pathIndex)}},
        usePageIndex:true,
        useBloomFilters:true
      });

      for(const row of rows){
        const objectIndex=Number(row.object_index),pathIndex=Number(row.path_index);
        if(!Number.isFinite(objectIndex))continue;
        const color=normalizeColor(valueOf(row));
        if(!color)continue;
        const priority=priorityByPath.get(pathIndex)||0;
        const current=best.get(objectIndex);
        if(!current||priority>current.priority)best.set(objectIndex,{priority,color});
      }
    }
  }catch(error){
    console.warn('EAV material color fallback',error instanceof Error?error.message:String(error));
  }

  for(const [objectIndex,item] of best)colors.set(objectIndex,item.color);
  materialColorCache.set(key,{at:Date.now(),colors});
  return colors;
}

async function envelopeNode(file:RemoteFile,id:number){
  const {parquetReadObjects,compressors}=await parquetLib();
  const rows=await parquetReadObjects({file,columns:['id','def_ref','transform'],compressors,rowStart:id,rowEnd:id+1});
  const node=rows[0];
  return node&&Number(node.id)===id?node:null;
}
function bytesToBase64(bytes:Uint8Array){
  let out='';const step=0x8000;
  for(let i=0;i<bytes.length;i+=step)out+=String.fromCharCode(...bytes.subarray(i,Math.min(i+step,bytes.length)));
  return btoa(out);
}
async function geometryRowsForObject(index:number,data:any,parquetReadObjects:any,compressors:any,maxRows=24,maxBytes=8*1024*1024){
  const relations=await parquet(data,'.envelope.relations.parquet');
  const nodes=await parquet(data,'.envelope.nodes.parquet');
  const geometryFiles=(data.files||[]).filter((f:any)=>/\.geometries(?:\.\d+)?\.parquet$/i.test(String(f.name||'')));
  if(!geometryFiles.length)return [];
  const rels=await parquetReadObjects({file:relations,columns:['rel','src','dst','ord'],compressors,filter:{src:{$eq:index}},usePageIndex:true,useBloomFilters:true});
  const targets:{geometryIndex:number,transform:any}[]=[];
  for(const relRow of rels){
    const rel=Number(relRow.rel),dst=Number(relRow.dst);
    if((rel===1||rel===2)&&Number.isFinite(dst))targets.push({geometryIndex:dst,transform:null});
    if(rel===8&&Number.isFinite(dst)){
      const instance=await envelopeNode(nodes,dst);
      const definition=Number(instance?.def_ref);
      if(Number.isFinite(definition)){
        const defRows=await parquetReadObjects({file:relations,columns:['rel','src','dst','ord'],compressors,filter:{src:{$eq:definition},rel:{$eq:4}},usePageIndex:true,useBloomFilters:true});
        for(const row of defRows)targets.push({geometryIndex:Number(row.dst),transform:instance?.transform??null});
      }
    }
  }
  const unique=[...new Map(targets.filter(t=>Number.isFinite(t.geometryIndex)).map(t=>[t.geometryIndex,t])).values()].slice(0,maxRows);
  const rows:any[]=[];let totalBytes=0;
  for(const target of unique){
    for(const geometryFile of geometryFiles){
      const gf=await remote(geometryFile);
      const matches=await parquetReadObjects({file:gf,columns:['geometryIndex','id','type','content'],compressors,filter:{geometryIndex:{$eq:target.geometryIndex}},usePageIndex:true,useBloomFilters:true,utf8:false});
      const row=matches[0];
      if(!row?.content)continue;
      const bytes=toBytes(row.content);
      if(!bytes.byteLength)continue;
      if(totalBytes+bytes.byteLength>maxBytes)return rows;
      totalBytes+=bytes.byteLength;
      rows.push({geometryIndex:target.geometryIndex,id:decodeText(row.id),type:decodeText(row.type),transform:target.transform,contentBase64:bytesToBase64(bytes)});
      break;
    }
  }
  return rows;
}

const PHD_SERVER_FORMAT='phd3d-spatial-v3.1';
const PHD_SERVER_BATCH_SIZE=512;
const PHD_SERVER_OBJECTS_PER_CHUNK=512;
const PHD_SERVER_MAX_RAW_BYTES=24*1024*1024;
const PHD_SERVER_UPLOAD_CONCURRENCY=8;
const PHD_SERVER_MAGIC=new Uint8Array([80,72,68,51,68,51,0,0]);
const PHD_SERVER_PREFIX_BYTES=12;

function phdDistributedSample(indices:number[],count=192){
  const source=[...(indices||[])];
  if(source.length<=count)return source;
  const result:number[]=[];
  const step=source.length/count;
  for(let i=0;i<count;i++)result.push(source[Math.min(source.length-1,Math.floor(i*step))]);
  return [...new Set(result)];
}

function phdAlign4(value:number){return (Number(value)+3)&~3}

async function phdMapConcurrent(items:any[],limit:number,worker:(item:any,index:number)=>Promise<any>){
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

function phdTriangulateFaces(faces:Int32Array,vertexCount:number){
  const indices:number[]=[];
  for(let i=0;i<faces.length;){
    let count=Number(faces[i++]);
    if(count<3)count+=3;
    if(count<3||count>4096||i+count>faces.length)break;
    const first=Number(faces[i]);
    if(first<0||first>=vertexCount){i+=count;continue}
    for(let j=1;j<count-1;j++){
      const b=Number(faces[i+j]),cc=Number(faces[i+j+1]);
      if(b>=0&&b<vertexCount&&cc>=0&&cc<vertexCount)indices.push(first,b,cc);
    }
    i+=count;
  }
  return indices;
}

function phdReadCoord(view:DataView,offset:number,size:number){
  return size===8?view.getFloat64(offset,true):view.getFloat32(offset,true);
}

function phdProbeLayout(view:DataView,total:number,vertexCount:number,faceIntCount:number,vertexOffset:number,size:number){
  const faceOffset=vertexOffset+vertexCount*3*size;
  const end=faceOffset+faceIntCount*4;
  if(vertexOffset<24||end>total)return null;
  let min=Infinity,max=-Infinity;
  const sample=Math.min(vertexCount,32);
  for(let i=0;i<sample;i++){
    const base=vertexOffset+i*3*size;
    for(let j=0;j<3;j++){
      const value=phdReadCoord(view,base+j*size,size);
      if(!Number.isFinite(value)||Math.abs(value)>1e16)return null;
      min=Math.min(min,value);max=Math.max(max,value);
    }
  }
  let cursor=faceOffset,checked=0,valid=0,polygons=0;
  while(checked<256&&cursor+4<=end&&polygons<24){
    let count=view.getInt32(cursor,true);cursor+=4;checked++;
    if(count<3)count+=3;
    if(count<3||count>4096||checked+count>faceIntCount)break;
    let ok=true;
    for(let j=0;j<count;j++){
      const index=view.getInt32(cursor+j*4,true);
      if(index>=0&&index<vertexCount)valid++;else ok=false;
      checked++;
    }
    if(ok)polygons++;
    cursor+=count*4;
  }
  if(!polygons||valid<3)return null;
  const exact=end===total?40:(total-end<64?20:0);
  return {vertexOffset,faceOffset,size,score:polygons*4+valid+exact,extent:max-min};
}

function phdDetectLayout(view:DataView,total:number,vertexCount:number,faceIntCount:number,minVertexOffset=24){
  const candidates:any[]=[];
  for(const size of [8,4]){
    for(let offset=minVertexOffset;offset<=Math.min(minVertexOffset+512,total-4);offset+=4){
      const result=phdProbeLayout(view,total,vertexCount,faceIntCount,offset,size);
      if(result)candidates.push(result);
    }
    for(let padding=0;padding<=256;padding+=4){
      const faceOffset=total-padding-faceIntCount*4;
      const offset=faceOffset-vertexCount*3*size;
      if(offset<minVertexOffset)continue;
      const result=phdProbeLayout(view,total,vertexCount,faceIntCount,offset,size);
      if(result)candidates.push(result);
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

function phdDetectSgeoStructure(view:DataView,total:number){
  const candidates:any[]=[];
  const maxHeader=Math.min(192,total-8);
  for(let countOffset=8;countOffset<=maxHeader;countOffset+=4){
    const vertexCount=view.getUint32(countOffset,true);
    const faceIntCount=view.getUint32(countOffset+4,true);
    if(!vertexCount||vertexCount>10_000_000||!faceIntCount||faceIntCount>40_000_000)continue;
    const layout=phdDetectLayout(view,total,vertexCount,faceIntCount,countOffset+8);
    if(!layout)continue;
    let score=layout.score;
    if(countOffset===16)score+=30;
    if(layout.vertexOffset===countOffset+8)score+=25;
    if(vertexCount<5_000_000)score+=5;
    if(faceIntCount<20_000_000)score+=5;
    candidates.push({countOffset,vertexCount,faceIntCount,layout,score});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

function phdDecodeSgeo(value:any){
  const bytes=toBytes(value);
  if(bytes.byteLength<24)return null;
  if(String.fromCharCode(...bytes.slice(0,4))!=='SGEO')return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes[4]!==1||bytes[5]!==0)return null;
  const structure=phdDetectSgeoStructure(view,bytes.byteLength);
  if(!structure)return null;
  const {vertexCount,faceIntCount,layout}=structure;
  const positions=new Float32Array(vertexCount*3);
  let offset=layout.vertexOffset;
  for(let i=0;i<positions.length;i++,offset+=layout.size){
    const n=phdReadCoord(view,offset,layout.size);
    if(!Number.isFinite(n)||Math.abs(n)>3.3e38)return null;
    positions[i]=n;
  }
  const faces=new Int32Array(faceIntCount);
  offset=layout.faceOffset;
  for(let i=0;i<faces.length;i++,offset+=4)faces[i]=view.getInt32(offset,true);
  const indices=phdTriangulateFaces(faces,vertexCount);
  if(!indices.length)return null;
  return {positions,indices};
}

function phdCreateGeometry(content:any){
  const decoded=phdDecodeSgeo(content);
  if(!decoded)return null;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(decoded.positions,3));
  geometry.setIndex(decoded.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function phdMatrixFromTransform(value:any){
  if(!value)return null;
  const values=Array.isArray(value)?value.map(Number):String(value).split(',').map(Number);
  if(values.length!==16||values.some((v:number)=>!Number.isFinite(v)))return null;
  const tol=1e-8;
  if(Math.abs(values[12])>tol||Math.abs(values[13])>tol||Math.abs(values[14])>tol||Math.abs(values[15]-1)>tol)return null;
  const matrix=new THREE.Matrix4();
  matrix.set(...values);
  const e=matrix.elements;
  const maxLinear=Math.max(Math.abs(e[0]),Math.abs(e[1]),Math.abs(e[2]),Math.abs(e[4]),Math.abs(e[5]),Math.abs(e[6]),Math.abs(e[8]),Math.abs(e[9]),Math.abs(e[10]));
  const maxTranslation=Math.max(Math.abs(e[12]),Math.abs(e[13]),Math.abs(e[14]));
  if(!Number.isFinite(maxLinear)||!Number.isFinite(maxTranslation)||maxLinear>1e6||maxTranslation>1e9)return null;
  return matrix;
}

function phdFiniteBox(box:any){
  if(!box||box.isEmpty())return false;
  return [box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z].every(Number.isFinite);
}

function phdBoxArray(box:any){
  if(!phdFiniteBox(box))return null;
  return [box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
}

function phdCenterFromBounds(bounds:any){
  if(!Array.isArray(bounds)||bounds.length!==6)return null;
  return [(Number(bounds[0])+Number(bounds[3]))/2,(Number(bounds[1])+Number(bounds[4]))/2,(Number(bounds[2])+Number(bounds[5]))/2];
}

function phdAnalyzeSpatial(objects:any[]){
  const preparedGeometry=new Map<number,any>();
  const identity=new THREE.Matrix4();
  for(const object of objects||[]){
    for(const row of object?.rows||[]){
      const geometryIndex=Number(row.geometryIndex);
      if(!Number.isFinite(geometryIndex)||preparedGeometry.has(geometryIndex))continue;
      const geometry=phdCreateGeometry(row.content);
      if(!geometry){preparedGeometry.set(geometryIndex,null);continue}
      const position=geometry.getAttribute('position');
      const normal=geometry.getAttribute('normal');
      const index=geometry.getIndex();
      if(!position?.array||!index?.array){geometry.dispose?.();preparedGeometry.set(geometryIndex,null);continue}
      const positions=position.array instanceof Float32Array?position.array:Float32Array.from(position.array as any);
      const normals=normal?.array?(normal.array instanceof Float32Array?normal.array:Float32Array.from(normal.array as any)):new Float32Array(positions.length);
      const indices=index.array instanceof Uint32Array?index.array:Uint32Array.from(index.array as any);
      const bbox=geometry.boundingBox?phdBoxArray(geometry.boundingBox):null;
      preparedGeometry.set(geometryIndex,{geometryIndex,id:String(row.id||''),type:String(row.type||''),positions,normals,indices,bbox});
      geometry.dispose?.();
    }
  }

  const enriched:any[]=[];
  const globalBox=new THREE.Box3().makeEmpty();
  for(const object of objects||[]){
    const objectBox=new THREE.Box3().makeEmpty();
    const preparedRows:any[]=[];
    for(const row of object?.rows||[]){
      const prepared=preparedGeometry.get(Number(row.geometryIndex));
      const bounds=prepared?.bbox;
      if(!prepared||!bounds)continue;
      preparedRows.push({...row,__phdPrepared:prepared});
      const box=new THREE.Box3(new THREE.Vector3(bounds[0],bounds[1],bounds[2]),new THREE.Vector3(bounds[3],bounds[4],bounds[5]));
      const hasTransform=row.transform!==null&&row.transform!==undefined&&String(row.transform).length>0;
      const matrix=hasTransform?phdMatrixFromTransform(row.transform):identity;
      if(hasTransform&&!matrix)continue;
      box.applyMatrix4(matrix||identity);
      const size=box.getSize(new THREE.Vector3());
      const values=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
      const sane=phdFiniteBox(box)&&values.every(value=>Math.abs(value)<=1e9)&&size.length()<1e8;
      if(sane)objectBox.union(box);
    }
    const bounds=phdBoxArray(objectBox);
    const center=phdCenterFromBounds(bounds);
    if(bounds)globalBox.union(objectBox);
    enriched.push({...object,rows:preparedRows,__phdBounds:bounds,__phdCenter:center});
  }

  if(!phdFiniteBox(globalBox))return enriched;
  const min=globalBox.min,size=globalBox.getSize(new THREE.Vector3());
  const sx=Math.max(size.x,1e-9),sy=Math.max(size.y,1e-9),sz=Math.max(size.z,1e-9);
  const key=(item:any)=>{
    const cc=item.__phdCenter;
    if(!cc)return Number.MAX_SAFE_INTEGER;
    const qx=Math.max(0,Math.min(1023,Math.floor(((cc[0]-min.x)/sx)*1023)));
    const qy=Math.max(0,Math.min(1023,Math.floor(((cc[1]-min.y)/sy)*1023)));
    const qz=Math.max(0,Math.min(1023,Math.floor(((cc[2]-min.z)/sz)*1023)));
    return qx*1048576+qy*1024+qz;
  };
  return enriched.sort((a,b)=>key(a)-key(b));
}

function phdUniqueGeometryIncrement(object:any,seen:Set<number>){
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

function phdSplitObjects(objects:any[]){
  const result:any[][]=[];
  let current:any[]=[],currentBytes=0,seen=new Set<number>();
  const flush=()=>{if(current.length)result.push(current);current=[];currentBytes=0;seen=new Set<number>()};
  for(const object of objects||[]){
    const testSeen=new Set(seen);
    const next=phdUniqueGeometryIncrement(object,testSeen);
    if(current.length&&(current.length>=PHD_SERVER_OBJECTS_PER_CHUNK||currentBytes+next>PHD_SERVER_MAX_RAW_BYTES))flush();
    current.push(object);
    currentBytes+=phdUniqueGeometryIncrement(object,seen);
  }
  flush();
  return result;
}

function phdBuildBinaryChunk(c:any,objects:any[]){
  const sources=new Map<number,any>();
  const objectCandidates:any[]=[];
  for(const object of objects||[]){
    const rows:any[]=[];
    for(const row of object?.rows||[]){
      const geometryIndex=Number(row.geometryIndex);
      if(!Number.isFinite(geometryIndex))continue;
      if(!sources.has(geometryIndex)){
        const prepared=row.__phdPrepared||null;
        sources.set(geometryIndex,prepared?{geometryIndex,id:String(prepared.id||row.id||''),type:String(prepared.type||row.type||''),prepared}:{geometryIndex,id:String(row.id||''),type:String(row.type||''),content:toBytes(row.content)});
      }
      rows.push({geometryIndex,transform:row.transform?String(row.transform):null});
    }
    if(rows.length)objectCandidates.push({
      objectIndex:Number(object.objectIndex),
      applicationId:String(object.applicationId||object.objectIndex),
      displayColor:object.displayColor?String(object.displayColor):null,
      rows,
      spatialBounds:Array.isArray(object.__phdBounds)?object.__phdBounds:null
    });
  }

  const decoded=new Map<number,any>();
  for(const source of sources.values()){
    if(source.prepared){decoded.set(source.geometryIndex,source.prepared);continue}
    const geometry=phdCreateGeometry(source.content);
    if(!geometry)continue;
    const position=geometry.getAttribute('position'),normal=geometry.getAttribute('normal'),index=geometry.getIndex();
    if(!position?.array||!index?.array){geometry.dispose?.();continue}
    const positions=position.array instanceof Float32Array?position.array:Float32Array.from(position.array as any);
    const normals=normal?.array?(normal.array instanceof Float32Array?normal.array:Float32Array.from(normal.array as any)):new Float32Array(positions.length);
    const indices=index.array instanceof Uint32Array?index.array:Uint32Array.from(index.array as any);
    const bbox=geometry.boundingBox?phdBoxArray(geometry.boundingBox):null;
    decoded.set(source.geometryIndex,{geometryIndex:source.geometryIndex,id:source.id,type:source.type,positions,normals,indices,bbox});
    geometry.dispose?.();
  }

  const objectTable=objectCandidates.map(object=>({
    objectIndex:object.objectIndex,
    applicationId:object.applicationId,
    displayColor:object.displayColor||null,
    rows:object.rows.filter((row:any)=>decoded.has(row.geometryIndex)),
    spatialBounds:object.spatialBounds
  })).filter(object=>object.rows.length);

  const geometryTable:any[]=[];
  let payloadBytes=0;
  for(const geometry of decoded.values()){
    payloadBytes=phdAlign4(payloadBytes);const positionOffset=payloadBytes,positionBytes=geometry.positions.byteLength;payloadBytes+=positionBytes;
    payloadBytes=phdAlign4(payloadBytes);const normalOffset=payloadBytes,normalBytes=geometry.normals.byteLength;payloadBytes+=normalBytes;
    payloadBytes=phdAlign4(payloadBytes);const indexOffset=payloadBytes,indexBytes=geometry.indices.byteLength;payloadBytes+=indexBytes;
    geometryTable.push({
      geometryIndex:geometry.geometryIndex,id:geometry.id,type:geometry.type,
      positionOffset,positionCount:geometry.positions.length,positionBytes,
      normalOffset,normalCount:geometry.normals.length,normalBytes,
      indexOffset,indexCount:geometry.indices.length,indexBytes,bbox:geometry.bbox
    });
  }

  const chunkBox=new THREE.Box3().makeEmpty();
  for(const object of objectTable){
    const bounds=object.spatialBounds;
    if(!Array.isArray(bounds)||bounds.length!==6)continue;
    const box=new THREE.Box3(new THREE.Vector3(bounds[0],bounds[1],bounds[2]),new THREE.Vector3(bounds[3],bounds[4],bounds[5]));
    if(phdFiniteBox(box))chunkBox.union(box);
  }
  const chunkBounds=phdBoxArray(chunkBox),chunkCenter=phdCenterFromBounds(chunkBounds);
  const header={
    format:PHD_SERVER_FORMAT,encoding:'gpu-ready-f32-u32',
    projectId:String(c?.project_id||''),modelId:String(c?.model_id||''),versionId:String(c?.version_id||''),
    objectCount:objectTable.length,
    instanceCount:objectTable.reduce((sum,item)=>sum+item.rows.length,0),
    geometryCount:geometryTable.length,
    objects:objectTable.map(({spatialBounds,...object})=>object),
    geometries:geometryTable,chunkBounds,chunkCenter
  };
  const headerBytes=new TextEncoder().encode(JSON.stringify(header));
  const payloadStart=phdAlign4(PHD_SERVER_PREFIX_BYTES+headerBytes.byteLength);
  const raw=new Uint8Array(payloadStart+payloadBytes);
  raw.set(PHD_SERVER_MAGIC,0);
  new DataView(raw.buffer).setUint32(8,headerBytes.byteLength,true);
  raw.set(headerBytes,PHD_SERVER_PREFIX_BYTES);
  for(const item of geometryTable){
    const geometry=decoded.get(item.geometryIndex);
    if(!geometry)continue;
    raw.set(new Uint8Array(geometry.positions.buffer,geometry.positions.byteOffset,geometry.positions.byteLength),payloadStart+item.positionOffset);
    raw.set(new Uint8Array(geometry.normals.buffer,geometry.normals.byteOffset,geometry.normals.byteLength),payloadStart+item.normalOffset);
    raw.set(new Uint8Array(geometry.indices.buffer,geometry.indices.byteOffset,geometry.indices.byteLength),payloadStart+item.indexOffset);
  }
  const objectIndices=objectTable.map(item=>Number(item.objectIndex)).filter(Number.isFinite);
  return {
    raw,objectCount:objectTable.length,instanceCount:header.instanceCount,uniqueGeometryCount:geometryTable.length,
    bounds:chunkBounds,center:chunkCenter,
    objectIndexMin:objectIndices.length?Math.min(...objectIndices):null,
    objectIndexMax:objectIndices.length?Math.max(...objectIndices):null
  };
}

async function phdGzip(bytes:Uint8Array){
  if(typeof CompressionStream==='undefined')return {bytes,compression:'none'};
  const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return {bytes:new Uint8Array(await new Response(stream).arrayBuffer()),compression:'gzip'};
}

async function phdFetchPrivate(base44:any,fileUri:string){
  const signed=await base44.integrations.Core.CreateFileSignedUrl({file_uri:String(fileUri||''),expires_in:3600});
  const response=await fetch(String(signed?.signed_url||''),{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('PHD3D private file HTTP '+response.status);
  return new Uint8Array(await response.arrayBuffer());
}

async function phdDefinitionGeometryMap(c:any,data:any,parquetReadObjects:any,compressors:any){
  const key=cacheKey(c);
  const existing=phdDefinitionGeometryCache.get(key);
  if(existing)return existing;

  const promise=(async()=>{
    const rows=await parquetReadObjects({
      file:await parquet(data,'.envelope.relations.parquet'),
      columns:['rel','src','dst'],
      compressors,
      filter:{rel:{$eq:4}},
      usePageIndex:true,
      useBloomFilters:true
    });
    const map=new Map<number,number[]>();
    for(const row of rows){
      const src=Number(row.src),dst=Number(row.dst);
      if(!Number.isFinite(src)||!Number.isFinite(dst))continue;
      const list=map.get(src)||[];
      list.push(dst);
      map.set(src,list);
    }
    return map;
  })();

  phdDefinitionGeometryCache.set(key,promise);
  try{return await promise}
  catch(error){
    phdDefinitionGeometryCache.delete(key);
    throw error;
  }
}

async function phdRenderableIndices(data:any,parquetReadObjects:any,compressors:any){
  const rows=await parquetReadObjects({
    file:await parquet(data,'.envelope.relations.parquet'),
    columns:['rel','src'],
    compressors,
    filter:{rel:{$in:[1,2,8]}},
    usePageIndex:true,
    useBloomFilters:true
  });
  const seen=new Set<number>(),indices:number[]=[];
  for(const row of rows){
    const src=Number(row.src);
    if(!Number.isFinite(src)||seen.has(src))continue;
    seen.add(src);indices.push(src);
  }
  return indices;
}

async function phdLoadGeometrySliceServer(c:any,data:any,indices:number[],parquetReadObjects:any,compressors:any,onStage?:(detail:string)=>Promise<void>,label='micro'){
  const relationsFile=await parquet(data,'.envelope.relations.parquet');
  const nodesFile=await parquet(data,'.envelope.nodes.parquet');
  await onStage?.(label+' · relações');
  const wantedSrc=new Set(indices.map(Number));
  const srcMin=Math.min(...indices);
  const srcMax=Math.max(...indices);
  const relationRows=await parquetReadObjects({
    file:relationsFile,columns:['rel','src','dst','ord'],compressors,
    filter:{src:{$gte:srcMin,$lte:srcMax}},usePageIndex:true,useBloomFilters:true
  });
  const relations=relationRows.filter(row=>wantedSrc.has(Number(row.src)));

  await onStage?.(label+' · relações OK · '+relations.length.toLocaleString('pt-BR')+' linha(s)');
  const direct:any[]=[],instanceRel:any[]=[];
  for(const row of relations){
    const rel=Number(row.rel),src=Number(row.src),dst=Number(row.dst);
    if(!Number.isFinite(src)||!Number.isFinite(dst))continue;
    if(rel===1||rel===2)direct.push({objectIndex:src,geometryIndex:dst,transform:null});
    if(rel===8)instanceRel.push({objectIndex:src,nodeId:dst});
  }

  const instanceIds=[...new Set(instanceRel.map(item=>item.nodeId))];
  const instancesByNode=new Map(instanceRel.map(item=>[item.nodeId,item]));
  const definitionTargets:any[]=[];
  if(instanceIds.length){
    await onStage?.(label+' · instâncias · '+instanceIds.length.toLocaleString('pt-BR'));
    const wantedNodeIds=new Set(instanceIds.map(Number));
    const nodeMin=Math.min(...instanceIds);
    const nodeMax=Math.max(...instanceIds);
    const nodeRangeRows=await parquetReadObjects({
      file:nodesFile,columns:['id','def_ref','transform'],compressors,
      filter:{id:{$gte:nodeMin,$lte:nodeMax}},usePageIndex:true,useBloomFilters:true
    });
    const nodeRows=nodeRangeRows.filter(row=>wantedNodeIds.has(Number(row.id)));
    const definitions:any[]=[];
    for(const row of nodeRows){
      const instance=instancesByNode.get(Number(row.id)),def=Number(row.def_ref);
      if(!instance||!Number.isFinite(def))continue;
      definitions.push({objectIndex:instance.objectIndex,definition:def,transform:row.transform??null});
    }
    const defIds=[...new Set(definitions.map(item=>item.definition))];
    if(defIds.length){
      await onStage?.(label+' · índice global de definições');
      const definitionGeometry=await phdDefinitionGeometryMap(c,data,parquetReadObjects,compressors);
      await onStage?.(label+' · definições indexadas · '+defIds.length.toLocaleString('pt-BR'));

      const definitionsById=new Map<number,any[]>();
      for(const item of definitions){
        const list=definitionsById.get(item.definition)||[];
        list.push(item);
        definitionsById.set(item.definition,list);
      }

      for(const definitionId of defIds){
        for(const geometryIndex of definitionGeometry.get(definitionId)||[]){
          for(const item of definitionsById.get(definitionId)||[]){
            definitionTargets.push({
              objectIndex:item.objectIndex,
              geometryIndex,
              transform:item.transform
            });
          }
        }
      }
    }
  }

  const targets=[...direct,...definitionTargets];
  const byGeometry=new Map<number,any[]>();
  for(const target of targets){
    if(!Number.isFinite(target.geometryIndex))continue;
    const list=byGeometry.get(target.geometryIndex)||[];list.push(target);byGeometry.set(target.geometryIndex,list);
  }
  const geometryIndices=[...byGeometry.keys()];
  const geometryRows=new Map<number,any>();
  let remaining=new Set(geometryIndices);
  const shards=(data.files||[]).filter((f:any)=>/\.geometries(?:\.\d+)?\.parquet$/i.test(String(f.name||'')));
  for(let shardIndex=0;shardIndex<shards.length;shardIndex++){
    if(!remaining.size)break;
    const shard=shards[shardIndex];
    const remoteShard=await remote(shard);
    await onStage?.(label+' · shard '+(shardIndex+1)+'/'+shards.length+' · '+remaining.size.toLocaleString('pt-BR')+' geometria(s)');

    const sorted=[...remaining].sort((a,b)=>a-b);
    const ranges:number[][]=[];
    let current:number[]=[];
    for(const geometryIndex of sorted){
      const first=current[0];
      const tooMany=current.length>=16;
      const tooWide=current.length>0&&geometryIndex-first>512;
      if(current.length&&(tooMany||tooWide)){
        ranges.push(current);
        current=[];
      }
      current.push(geometryIndex);
    }
    if(current.length)ranges.push(current);

    for(let rangeIndex=0;rangeIndex<ranges.length&&remaining.size;rangeIndex++){
      const group=ranges[rangeIndex];
      const wanted=new Set(group);
      const minGeometry=group[0];
      const maxGeometry=group[group.length-1];
      await onStage?.(
        label+' · shard '+(shardIndex+1)+'/'+shards.length+
        ' · faixa '+(rangeIndex+1)+'/'+ranges.length+
        ' · '+group.length+' geometria(s)'
      );
      const rangeRows=await parquetReadObjects({
        file:remoteShard,
        columns:['geometryIndex','id','type','content'],compressors,
        filter:{geometryIndex:{$gte:minGeometry,$lte:maxGeometry}},
        usePageIndex:true,useBloomFilters:true,utf8:false
      });
      for(const row of rangeRows){
        const geometryIndex=Number(row.geometryIndex);
        if(!wanted.has(geometryIndex)||!remaining.has(geometryIndex))continue;
        geometryRows.set(geometryIndex,{
          geometryIndex,
          id:decodeText(row.id),
          type:decodeText(row.type),
          content:toBytes(row.content)
        });
        remaining.delete(geometryIndex);
      }
    }
  }

  const grouped=new Map<number,any[]>();
  for(const [geometryIndex,row] of geometryRows){
    for(const target of byGeometry.get(geometryIndex)||[]){
      const list=grouped.get(target.objectIndex)||[];
      list.push({...row,transform:target.transform});
      grouped.set(target.objectIndex,list);
    }
  }

  let appRows:any[]=[];
  try{
    appRows=await parquetReadObjects({
      file:await parquet(data,'.eav.objects.parquet'),
      columns:['object_index','application_id'],compressors,
      filter:{object_index:{$in:indices}},usePageIndex:true,useBloomFilters:true
    });
  }catch{}
  const appByIndex=new Map(appRows.map(row=>[Number(row.object_index),String(row.application_id||row.object_index)]));

  return indices
    .filter(index=>grouped.has(index))
    .map(index=>({objectIndex:index,applicationId:appByIndex.get(index)||String(index),displayColor:null,rows:grouped.get(index)}));
}

async function phdLoadGeometryBatchServer(c:any,data:any,indices:number[],parquetReadObjects:any,compressors:any,onStage?:(detail:string)=>Promise<void>){
  const source=[...new Set((indices||[]).map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
  if(!source.length)return [];

  // Evita filtros $in gigantes sobre relations/geometries.parquet. Cada
  // micro-lote lê apenas o conjunto necessário de SGEO e libera memória
  // antes da etapa de conversão do lote principal.
  const microSize=128;
  const slices:any[]=[];
  for(let offset=0;offset<source.length;offset+=microSize){
    slices.push(source.slice(offset,offset+microSize));
  }

  const parts=await phdMapConcurrent(slices,2,async (slice,index)=>
    phdLoadGeometrySliceServer(
      c,data,slice,parquetReadObjects,compressors,onStage,
      'micro '+(index+1)+'/'+slices.length
    )
  );

  const byObject=new Map<number,any>();
  for(const part of parts){
    for(const object of part||[]){
      const objectIndex=Number(object?.objectIndex);
      if(Number.isFinite(objectIndex))byObject.set(objectIndex,object);
    }
  }
  return source.map(index=>byObject.get(index)).filter(Boolean);
}

function phdChunkRecord(c:any,manifest:any,descriptor:any){
  return {
    cache_key:String(manifest.cache_key||''),
    manifest_id:String(manifest.id||''),
    project_id:String(c.project_id||''),
    model_id:String(c.model_id||''),
    version_id:String(c.version_id||''),
    format_version:PHD_SERVER_FORMAT,
    chunk_index:Number(descriptor.chunkIndex),
    file_uri:String(descriptor.fileUri||''),
    compression:String(descriptor.compression||'none'),
    role:'detail',lod:2,
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

async function phdLatestManifest(base44:any,c:any){
  const rows=await base44.entities.GeometryCacheManifest.filter({cache_key:cacheKey(c)},'-updated_date',5);
  return rows?.[0]||null;
}

function phdIngestResponse(manifest:any){
  if(!manifest)return {ok:true,status:'missing',phase:'queued',progress:0,done:false};
  return {
    ok:true,
    manifestId:manifest.id||null,
    status:String(manifest.status||'building'),
    phase:String(manifest.ingest_phase||'queued'),
    progress:Number(manifest.ingest_progress||0),
    detail:String(manifest.ingest_detail||''),
    totalObjects:Number(manifest.total_objects||0),
    cachedObjects:Number(manifest.cached_objects||0),
    processedObjects:Number(manifest.next_object_offset||0),
    chunks:Number(manifest.cached_chunks||0),
    totalBytes:Number(manifest.total_bytes||0),
    totalBatches:Number(manifest.total_batches||0),
    nextBatchIndex:Number(manifest.next_batch_index||0),
    serverSide:!!manifest.server_side,
    done:String(manifest.status||'')==='ready'
  };
}

async function phdStartIngestion(base44:any,c:any,data:any,force=false){
  const existing=await phdLatestManifest(base44,c);
  if(existing&&!force&&existing.server_side&&existing.source_index_uri&&['building','partial'].includes(String(existing.status||''))){
    if(String(existing.status||'')==='partial'&&String(existing.ingest_phase||'')==='viewer-ready'){
      const resumed=await base44.entities.GeometryCacheManifest.update(existing.id,{
        status:'building',
        ingest_phase:'queued',
        ingest_detail:'Otimização do cache retomada a partir do checkpoint. O Viewer continua disponível durante o processamento.',
        error_message:'',
        last_heartbeat_at:new Date().toISOString()
      });
      return phdIngestResponse({...existing,...resumed,status:'building',ingest_phase:'queued'});
    }
    return phdIngestResponse(existing);
  }
  if(existing&&!force&&existing.server_side&&existing.status==='ready'&&existing.format_version===PHD_SERVER_FORMAT){
    return phdIngestResponse(existing);
  }

  const {parquetReadObjects,compressors}=await parquetLib();
  const renderable=await phdRenderableIndices(data,parquetReadObjects,compressors);
  if(!renderable.length)throw new Error('Nenhum objeto renderizável foi localizado para a ingestão PHD3D.');

  const existingBatchSize=Math.min(PHD_SERVER_BATCH_SIZE,Math.max(512,Number(existing?.preparation_batch_size||PHD_SERVER_BATCH_SIZE)));
  const existingOffset=Math.max(0,Number(existing?.next_object_offset||0));
  const canMigrateLegacy=!!(
    !force&&
    existing&&
    !existing.server_side&&
    existing.format_version===PHD_SERVER_FORMAT&&
    ['building','partial','error'].includes(String(existing.status||''))&&
    Number(existing.cached_chunks||0)>0&&
    existingOffset>0&&
    existingBatchSize>=512&&existingBatchSize<=8192
  );

  let sourceIndices=renderable;
  let migratingLegacy=false;
  if(canMigrateLegacy){
    const previewSet=new Set(phdDistributedSample(renderable,192));
    const pending=renderable.filter(index=>!previewSet.has(index));
    if(existingOffset<=pending.length){
      sourceIndices=pending;
      migratingLegacy=true;
    }
  }

  const typed=Uint32Array.from(sourceIndices);
  const file=new File([new Uint8Array(typed.buffer)],'phd3d-index-'+String(c.version_id||'model')+'.u32',{type:'application/octet-stream'});
  const uploaded=await base44.integrations.Core.UploadPrivateFile({file});
  if(!uploaded?.file_uri)throw new Error('Falha ao persistir o índice de ingestão PHD3D.');

  const key=cacheKey(c);
  const now=new Date().toISOString();

  if(migratingLegacy&&existing){
    const batchSize=existingBatchSize;
    const totalBatches=Math.ceil(sourceIndices.length/batchSize);
    const migratedProgress=Math.max(1,Math.min(99,Math.round((existingOffset/Math.max(1,sourceIndices.length))*100)));
    const payload:any={
      status:'building',
      total_objects:Number(existing.total_objects||renderable.length),
      total_batches:totalBatches,
      next_object_offset:existingOffset,
      next_batch_index:Math.floor(existingOffset/batchSize),
      preparation_batch_size:batchSize,
      completed_at:'',
      error_message:'',
      ingest_phase:'queued',
      ingest_progress:migratedProgress,
      ingest_detail:'Checkpoint migrado para o backend · retomando no lote '+Math.floor(existingOffset/batchSize)+' de '+totalBatches+' sem refazer os '+Number(existing.cached_objects||0).toLocaleString('pt-BR')+' objetos já preparados.',
      source_index_uri:String(uploaded.file_uri),
      server_side:true,
      last_checkpoint_at:now,
      last_heartbeat_at:now,
      source:'Speckle Bundle → PHD3D Spatial v3 · migrado para Server Ingestion'
    };
    const manifest=await base44.entities.GeometryCacheManifest.update(existing.id,payload);
    return phdIngestResponse({...existing,...payload,...manifest});
  }

  try{await base44.entities.GeometryCacheChunk.deleteMany({cache_key:key})}catch{}
  try{await base44.entities.HyperViewRenderPack.deleteMany({project_id:String(c.project_id||''),model_id:String(c.model_id||''),version_id:String(c.version_id||'')})}catch{}
  try{await base44.entities.HyperViewRenderManifest.deleteMany({project_id:String(c.project_id||''),model_id:String(c.model_id||''),version_id:String(c.version_id||'')})}catch{}

  const totalBatches=Math.ceil(sourceIndices.length/PHD_SERVER_BATCH_SIZE);
  const payload:any={
    project_id:String(c.project_id||''),model_id:String(c.model_id||''),version_id:String(c.version_id||''),
    cache_key:key,status:'building',format_version:PHD_SERVER_FORMAT,
    total_objects:renderable.length,cached_objects:0,total_chunks:0,cached_chunks:0,total_bytes:0,chunks_json:'[]',
    source:'Speckle Bundle → PHD3D Server Ingestion v1',
    completed_at:'',error_message:'',
    next_batch_index:0,total_batches:totalBatches,next_object_offset:0,preparation_batch_size:PHD_SERVER_BATCH_SIZE,
    last_checkpoint_at:now,upload_failures:0,
    ingest_phase:'queued',ingest_progress:1,ingest_detail:'Ingestão enfileirada no backend. Preparando artifacts do Speckle.',
    source_index_uri:String(uploaded.file_uri),server_side:true,last_heartbeat_at:now
  };

  let manifest;
  if(existing)manifest=await base44.entities.GeometryCacheManifest.update(existing.id,payload);
  else manifest=await base44.entities.GeometryCacheManifest.create(payload);
  return phdIngestResponse({...existing,...payload,...manifest});
}

function phdScheduleBackgroundContinuation(base44:any,c:any){
  if(!c?.id)return false;

  // Não reinvoca a própria função HTTP: essa recursão gerava HTTP 500 no
  // runtime Base44. O trabalho pesado continua diretamente no waitUntil.
  waitUntil((async()=>{
    try{
      const data=await artifacts(c);
      await phdContinueIngestion(base44,c,data);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      try{
        const manifest=await phdLatestManifest(base44,c);
        if(manifest&&String(manifest.status||'')!=='ready'){
          const hasUsableCache=Number(manifest.cached_chunks||0)>0;
          await base44.entities.GeometryCacheManifest.update(manifest.id,{
            status:hasUsableCache?'partial':'error',
            ingest_phase:hasUsableCache?'viewer-ready':'error',
            ingest_detail:hasUsableCache
              ? 'A execução server-side foi interrompida, mas o cache parcial está utilizável. O Viewer completa o restante por streaming do Bundle.'
              : 'A execução server-side foi interrompida antes de produzir cache utilizável.',
            error_message:hasUsableCache?'':message,
            last_checkpoint_at:new Date().toISOString(),
            last_heartbeat_at:new Date().toISOString()
          });
        }
      }catch{}
    }
  })());

  return true;
}

async function phdContinueIngestion(base44:any,c:any,data:any){
  const started=Date.now();
  let state:any=null;

  // Processa vários lotes em uma única execução server-side, sem depender
  // do navegador. Mantém uma margem de segurança para o limite do runtime
  // e agenda automaticamente a próxima execução quando necessário.
  for(let step=0;step<8;step++){
    state=await phdNextIngestion(base44,c,data);
    if(state?.done||String(state?.status||'')==='ready')return state;
    if(Date.now()-started>70000)break;
  }

  let manifest=await phdLatestManifest(base44,c);
  if(manifest&&!['ready','error'].includes(String(manifest.status||''))){
    manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
      status:'partial',
      ingest_phase:'queued',
      ingest_detail:'Janela de processamento concluída no backend. Checkpoint salvo; preparando a próxima janela.',
      error_message:'',
      last_checkpoint_at:new Date().toISOString(),
      last_heartbeat_at:new Date().toISOString()
    });
  }
  return phdIngestResponse(manifest);
}

async function phdNextIngestion(base44:any,c:any,data:any){
  let manifest=await phdLatestManifest(base44,c);
  if(!manifest||!manifest.server_side||!manifest.source_index_uri)throw new Error('Ingestão server-side não iniciada.');
  if(manifest.status==='ready')return phdIngestResponse(manifest);

  try{
    const rawIndex=await phdFetchPrivate(base44,String(manifest.source_index_uri||''));
    const copied=rawIndex.slice();
    const allIndices=new Uint32Array(copied.buffer,copied.byteOffset,Math.floor(copied.byteLength/4));
    const total=allIndices.length;
    // Lotes grandes (4k+) podem estourar CPU/memória do filtro Parquet em
    // regiões densas do Navisworks. O servidor limita a 512 objetos e
    // preserva o offset já concluído, portanto a retomada não reprocessa o modelo.
    const batchSize=Math.min(PHD_SERVER_BATCH_SIZE,Math.max(512,Number(manifest.preparation_batch_size||PHD_SERVER_BATCH_SIZE)));
    const start=Math.max(0,Number(manifest.next_object_offset||0));
    const totalBatches=Math.ceil(total/batchSize);
    if(start>=total){
      manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
        status:'ready',ingest_phase:'packing',ingest_progress:100,
        ingest_detail:'Conversão PHD3D concluída. Preparando publicação HyperView.',
        completed_at:new Date().toISOString(),error_message:'',last_checkpoint_at:new Date().toISOString(),last_heartbeat_at:new Date().toISOString()
      });
      return phdIngestResponse(manifest);
    }

    const end=Math.min(total,start+batchSize);
    const indices=Array.from(allIndices.slice(start,end));
    const batchNumber=Math.floor(start/batchSize);
    const baseProgress=Math.max(2,Math.min(99,Math.round((start/Math.max(1,total))*1000)/10));

    await base44.entities.GeometryCacheManifest.update(manifest.id,{
      status:'building',ingest_phase:'reading',ingest_progress:baseProgress,
      preparation_batch_size:batchSize,total_batches:totalBatches,next_batch_index:batchNumber,
      ingest_detail:'Lendo '+indices.length.toLocaleString('pt-BR')+' objetos diretamente no backend · lote '+(batchNumber+1)+'/'+totalBatches,
      last_heartbeat_at:new Date().toISOString(),error_message:''
    });

    const {parquetReadObjects,compressors}=await parquetLib();
    const reportStage=async(detail:string)=>{
      await base44.entities.GeometryCacheManifest.update(manifest.id,{
        ingest_phase:'reading',
        ingest_detail:'Lote '+(batchNumber+1)+'/'+totalBatches+' · '+detail,
        last_heartbeat_at:new Date().toISOString()
      });
    };
    const objectsForBatch=await phdLoadGeometryBatchServer(c,data,indices,parquetReadObjects,compressors,reportStage);

    await base44.entities.GeometryCacheManifest.update(manifest.id,{
      ingest_phase:'converting',
      ingest_detail:'Convertendo '+objectsForBatch.length.toLocaleString('pt-BR')+' objetos SGEO → PHD3D GPU-ready no servidor.',
      last_heartbeat_at:new Date().toISOString()
    });

    const analyzed=phdAnalyzeSpatial(objectsForBatch);
    const groups=phdSplitObjects(analyzed);
    const chunkBase=batchNumber*1000;

    try{
      await base44.entities.GeometryCacheChunk.deleteMany({
        cache_key:String(manifest.cache_key||''),
        chunk_index:{$gte:chunkBase,$lt:chunkBase+1000}
      });
    }catch{}

    const binaries=groups.map((group,index)=>({chunkIndex:chunkBase+index,binary:phdBuildBinaryChunk(c,group)})).filter(item=>item.binary.objectCount>0);
    const packed=await phdMapConcurrent(binaries,4,async item=>{
      const gz=await phdGzip(item.binary.raw);
      return {...item,packed:gz.bytes,compression:gz.compression};
    });

    await base44.entities.GeometryCacheManifest.update(manifest.id,{
      ingest_phase:'packing',
      ingest_detail:'Compactando e publicando '+packed.length.toLocaleString('pt-BR')+' chunk(s) PHD3D em paralelo.',
      last_heartbeat_at:new Date().toISOString()
    });

    const uploaded=await phdMapConcurrent(packed,PHD_SERVER_UPLOAD_CONCURRENCY,async item=>{
      const file=new File(
        [item.packed],
        'phd3d-'+String(c.version_id||'model')+'-'+String(item.chunkIndex).padStart(6,'0')+'.phd3d'+(item.compression==='gzip'?'.gz':''),
        {type:item.compression==='gzip'?'application/gzip':'application/octet-stream'}
      );
      const result=await base44.integrations.Core.UploadPrivateFile({file});
      if(!result?.file_uri)throw new Error('Upload PHD3D sem file_uri no chunk '+item.chunkIndex+'.');
      return {
        chunkIndex:item.chunkIndex,fileUri:String(result.file_uri),compression:item.compression,
        objectCount:item.binary.objectCount,instanceCount:item.binary.instanceCount,uniqueGeometryCount:item.binary.uniqueGeometryCount,
        bounds:item.binary.bounds,center:item.binary.center,
        objectIndexMin:item.binary.objectIndexMin,objectIndexMax:item.binary.objectIndexMax,
        rawBytes:item.binary.raw.byteLength,packedBytes:item.packed.byteLength
      };
    });

    if(uploaded.length){
      await base44.entities.GeometryCacheChunk.bulkCreate(uploaded.map(item=>phdChunkRecord(c,manifest,item)));
    }

    const preparedObjects=uploaded.reduce((sum,item)=>sum+Number(item.objectCount||0),0);
    const addedBytes=uploaded.reduce((sum,item)=>sum+Number(item.packedBytes||0),0);
    const cachedObjects=Number(manifest.cached_objects||0)+preparedObjects;
    const cachedChunks=Number(manifest.cached_chunks||0)+uploaded.length;
    const totalBytes=Number(manifest.total_bytes||0)+addedBytes;
    const done=end>=total;
    const progress=done?100:Math.max(baseProgress,Math.min(99,Math.round((end/Math.max(1,total))*1000)/10));

    manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
      status:done?'ready':'building',
      cached_objects:cachedObjects,cached_chunks:cachedChunks,total_chunks:cachedChunks,total_bytes:totalBytes,
      next_object_offset:end,next_batch_index:batchNumber+1,total_batches:totalBatches,preparation_batch_size:batchSize,
      ingest_phase:done?'packing':'converting',
      ingest_progress:progress,
      ingest_detail:done
        ? 'Conversão PHD3D concluída no backend. Preparando publicação HyperView.'
        : end.toLocaleString('pt-BR')+' / '+total.toLocaleString('pt-BR')+' objetos processados no servidor.',
      completed_at:done?new Date().toISOString():'',
      last_checkpoint_at:new Date().toISOString(),last_heartbeat_at:new Date().toISOString(),error_message:''
    });

    return phdIngestResponse(manifest);
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const resumable=Number(manifest?.cached_chunks||0)>0||Number(manifest?.next_object_offset||0)>0;
    try{
      manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
        status:resumable?'partial':'error',
        ingest_phase:resumable?'viewer-ready':'error',
        ingest_detail:resumable
          ? 'O backend atingiu um limite durante a leitura SGEO. O cache parcial foi preservado e o Viewer seguirá pelo Bundle para os objetos restantes.'
          : 'Falha na ingestão server-side.',
        error_message:resumable?'':message,
        last_checkpoint_at:new Date().toISOString(),
        last_heartbeat_at:new Date().toISOString()
      });
    }catch{}
    throw error;
  }
}

function derive(props:{path:string,value:any,unit?:any}[]){
  const find=(rules:(string|RegExp)[])=>{
    for(const rule of rules){
      const h=props.find(x=>typeof rule==='string'?norm(x.path).endsWith(norm(rule)):rule.test(norm(x.path)));
      if(h&&h.value!==null&&h.value!=='')return h.value;
    }
    return null;
  };
  return {
    name:find(['name','properties.displayname','properties.name']),
    category:find([/category$/, /categoria$/]),discipline:find([/discipline$/, /disciplina$/]),
    system:find([/system$/, /sistema$/]),level:find([/level$/, /nivel$/]),
    cwa:find([/\.cwa$/, /cwa$/]),cwp:find([/\.cwp$/, /cwp$/]),tag:find([/\.tag$/, /tag$/]),
    guid:find([/guid$/, /external id$/]),family:find([/family$/, /familia$/]),
    type:find([/type$/, /tipo$/]),material:find([/material$/]),source_file:find([/source file$/]),
    speckle_type:find(['speckle_type'])
  };
}

export default async function(req:any){
  if(req.method!=='POST')return json({error:'Use POST.'},200);
  try{
    const base44=createClientFromRequest(req);
    const user=await base44.auth.me();
    if(!user)return json({error:'Autenticação necessária.'},200);
    const body=await req.json();
    const action=String(body.action||'status');
    const allowed=['status','tree','treeAll','collectionObjects','collectionObjectIndices','collectionObjectsBatch','collectionColorGroups','properties','search','viewer','focusGeometry','renderBatch','geometryArtifacts','materialColorsBatch','materialColorGroups','saveGeometryProbe','ingestStatus','ingestStart','ingestNext','ingestContinue'];
    if(!allowed.includes(action))return json({error:'Operação inválida.'},200);
    const c=await resolveConnection(base44,body);

    if(action==='ingestStatus'){
      let manifest=await phdLatestManifest(base44,c);
      if(manifest?.server_side&&String(manifest.status||'')==='building'){
        const heartbeat=Date.parse(String(manifest.last_heartbeat_at||manifest.updated_date||''));
        if(Number.isFinite(heartbeat)&&Date.now()-heartbeat>90000){
          const hasUsableCache=Number(manifest.cached_chunks||0)>0;
          manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
            status:hasUsableCache?'partial':'error',
            ingest_phase:hasUsableCache?'viewer-ready':'error',
            ingest_detail:hasUsableCache
              ? 'Cache parcial utilizável. O Viewer foi liberado e completa os objetos ausentes por streaming direto do Bundle.'
              : 'A preparação expirou antes de produzir chunks utilizáveis.',
            error_message:'',
            last_checkpoint_at:new Date().toISOString()
          });
        }
      }

      const canAutoResume=manifest?.server_side
        &&String(manifest.status||'')==='partial'
        &&String(manifest.ingest_phase||'')==='queued'
        &&!!manifest.source_index_uri
        &&!String(manifest.error_message||'')
        &&String(user.role||'').toLowerCase()==='admin';

      if(canAutoResume){
        manifest=await base44.entities.GeometryCacheManifest.update(manifest.id,{
          status:'building',
          ingest_phase:'queued',
          ingest_detail:'Retomando automaticamente a conversão no backend a partir do checkpoint salvo.',
          error_message:'',
          last_heartbeat_at:new Date().toISOString()
        });
        phdScheduleBackgroundContinuation(base44,c);
      }

      return json(phdIngestResponse(manifest));
    }

    if(action==='saveGeometryProbe'){
      const probe=body.probe||{};
      const payload={
        project_id:String(c.project_id||''),
        model_id:String(c.model_id||''),
        version_id:String(c.version_id||''),
        object_index:Number(probe.object_index),
        geometry_index:Number(probe.geometry_index),
        byte_length:Number(probe.byte_length||0),
        head_hex:String(probe.head_hex||''),
        tail_hex:String(probe.tail_hex||''),
        transform:String(probe.transform||''),
        content_base64:String(probe.content_base64||''),
        content_truncated:!!probe.content_truncated,
        source:'PHD Native Viewer',
        note:'Amostra automática para depuração SGEO'
      };
      if(!Number.isFinite(payload.object_index)||!Number.isFinite(payload.geometry_index)||!payload.byte_length){
        throw new Error('Probe SGEO inválido.');
      }
      const existing=await base44.entities.GeometryProbe.filter({
        project_id:payload.project_id,
        version_id:payload.version_id,
        object_index:payload.object_index,
        geometry_index:payload.geometry_index
      },'-updated_date',1);
      let saved;
      if(existing?.[0])saved=await base44.entities.GeometryProbe.update(existing[0].id,payload);
      else saved=await base44.entities.GeometryProbe.create(payload);
      return json({ok:true,id:saved?.id||existing?.[0]?.id||null});
    }

    const data=await artifacts(c);
    const files=data.files||[];
    const names=files.map((f:any)=>String(f.name||''));
    const hasEnvelope=names.some((n:string)=>n.endsWith('.envelope.nodes.parquet'))&&names.some((n:string)=>n.endsWith('.envelope.relations.parquet'));
    const hasEav=names.some((n:string)=>n.endsWith('.eav.objects.parquet'))&&names.some((n:string)=>n.endsWith('.eav.paths.parquet'))&&names.some((n:string)=>n.endsWith('.eav.eav.parquet'));
    const viewerUrl=`${speckleOrigin}/projects/${c.project_id}/models/${c.model_id}@${c.version_id}#embed=%7B%22isEnabled%22%3Atrue%7D`;

    if(action==='ingestStart'||action==='ingestNext'||action==='ingestContinue'){
      if(String(user.role||'').toLowerCase()!=='admin')return json({error:'Apenas administradores podem executar a ingestão PHD3D server-side.'},200);
      if(!hasEnvelope||!hasEav)throw new Error('Bundle sem Envelope/EAV necessários para a ingestão PHD3D.');

      if(action==='ingestStart'){
        const started=await phdStartIngestion(base44,c,data,!!body.force);
        if(!started?.done){
          // O processamento passa a continuar no backend mesmo que o usuário
          // feche a aba ou a conexão do navegador oscile.
          phdScheduleBackgroundContinuation(base44,c);
        }
        return json(started);
      }

      if(action==='ingestContinue'){
        return json(await phdContinueIngestion(base44,c,data));
      }

      return json(await phdNextIngestion(base44,c,data));
    }

    if(action==='viewer')return json({ok:true,viewerUrl,hasEnvelope,hasEav,fileCount:files.length});
    if(action==='geometryArtifacts'){
      const relations=files.find((f:any)=>String(f.name||'').endsWith('.envelope.relations.parquet'));
      const nodes=files.find((f:any)=>String(f.name||'').endsWith('.envelope.nodes.parquet'));
      const geometries=files.filter((f:any)=>/\.geometries(?:\.\d+)?\.parquet$/i.test(String(f.name||'')));
      if(!relations?.url||!nodes?.url||!geometries.length)throw new Error('Artifacts de geometria incompletos no Bundle.');
      const descriptor=async(f:any)=>({
        name:String(f?.name||''),
        url:String(f?.url||''),
        size:Number(f?.size||f?.byteLength||f?.contentLength||0)||Number((await remote(f)).byteLength)||null
      });
      return json({ok:true,files:{
        relations:await descriptor(relations),
        nodes:await descriptor(nodes),
        geometries:await Promise.all(geometries.map(descriptor))
      }});
    }
    if(action==='materialColorsBatch'){
      const requested=Array.isArray(body.objectIndices)?body.objectIndices.map(Number).filter(Number.isFinite):[];
      const indices=[...new Set(requested)].slice(0,5000);
      if(!indices.length)return json({ok:true,colors:{}});
      const index=await materialColors(c,data);
      const colors:Record<string,string>={};
      for(const objectIndex of indices){
        const color=index.get(objectIndex);
        if(color)colors[String(objectIndex)]=color;
      }
      return json({ok:true,colors,count:Object.keys(colors).length});
    }
    if(action==='materialColorGroups'){
      const index=await materialColors(c,data);
      const grouped=new Map<string,number[]>();
      for(const [objectIndex,color] of index){
        const list=grouped.get(color)||[];
        list.push(objectIndex);
        grouped.set(color,list);
      }
      const groups=[...grouped.entries()].map(([color,objectIndices])=>({color,objectIndices}));
      return json({
        ok:true,
        resolver:'bundle-appearance-v4',
        count:index.size,
        groupCount:groups.length,
        groups
      });
    }
    if(action==='status'){
      let objectCount=0,parquetReady=false,parquetError='';
      if(hasEav){
        try{
          const {parquetMetadataAsync}=await parquetLib();
          const meta=await parquetMetadataAsync(await parquet(data,'.eav.objects.parquet'));
          objectCount=Number(meta?.num_rows||0);parquetReady=true;
        }catch(e){parquetError=e instanceof Error?e.message:String(e)}
      }
      return json({ok:true,format:'bundle',viewerUrl,fileCount:files.length,hasEnvelope,hasEav,objectCount,parquetReady,parquetError,
        hasGeometry:names.some((n:string)=>n.endsWith('.geometries.parquet'))});
    }
    if(!hasEnvelope||!hasEav)throw new Error('Bundle sem Envelope/EAV necessários para a navegação PHD.');

    const {parquetReadObjects,compressors}=await parquetLib();

    if(action==='treeAll'){
      const nf=await parquet(data,'.envelope.nodes.parquet');
      let rows=await parquetReadObjects({file:nf,columns:['id','kind','name','def_ref','subtype'],compressors,filter:{kind:{$eq:7}},usePageIndex:true,useBloomFilters:true});
      rows=rows
        .filter((x:any)=>x.name&&String(x.subtype||'')==='Collection'&&!String(x.name||'').startsWith('0.svf'))
        .map((x:any)=>({id:Number(x.id),name:String(x.name),parentId:x.def_ref==null?null:Number(x.def_ref),subtype:String(x.subtype||'Collection'),expandable:true}))
        .slice(0,10000);
      return json({ok:true,total:rows.length,nodes:rows});
    }

    if(action==='tree'){
      const parent=body.parentId===null||body.parentId===undefined||body.parentId===''?null:Number(body.parentId);
      const nf=await parquet(data,'.envelope.nodes.parquet');
      let rows:any[]=[];
      if(parent===null){
        rows=await parquetReadObjects({file:nf,columns:['id','kind','name','def_ref','subtype'],compressors,filter:{def_ref:{$eq:null},kind:{$eq:7}},usePageIndex:true,useBloomFilters:true});
        rows=rows.filter((x:any)=>String(x.subtype||'')==='Collection'&&!String(x.name||'').startsWith('0.svf'));
      }else{
        rows=await parquetReadObjects({file:nf,columns:['id','kind','name','def_ref','subtype'],compressors,filter:{def_ref:{$eq:parent},kind:{$eq:7}},usePageIndex:true,useBloomFilters:true});
      }
      rows=rows.filter((x:any)=>x.name).sort((a:any,b:any)=>String(a.name).localeCompare(String(b.name))).slice(0,500);
      return json({ok:true,nodes:rows.map((x:any)=>({id:Number(x.id),name:String(x.name),parentId:x.def_ref==null?null:Number(x.def_ref),subtype:String(x.subtype||'Collection'),expandable:true}))});
    }

    if(action==='collectionColorGroups'){
      const groupKey=cacheKey(c)+'|collection-groups-v1';
      const cached=collectionGroupCache.get(groupKey);
      if(cached&&Date.now()-cached.at<30*60*1000){
        return json({ok:true,groups:cached.groups,totalGroups:cached.groups.length,source:'cache'});
      }

      const nf=await parquet(data,'.envelope.nodes.parquet');
      const rf=await parquet(data,'.envelope.relations.parquet');
      let nodeRows=await parquetReadObjects({
        file:nf,
        columns:['id','kind','name','def_ref','subtype'],
        compressors,
        filter:{kind:{$eq:7}},
        usePageIndex:true,
        useBloomFilters:true
      });
      nodeRows=nodeRows.filter((row:any)=>row?.name&&String(row.subtype||'')==='Collection'&&!String(row.name).startsWith('0.svf'));
      const byId=new Map<number,any>();
      for(const row of nodeRows){
        const id=Number(row.id);
        if(Number.isFinite(id))byId.set(id,{
          id,
          name:String(row.name),
          parentId:row.def_ref==null?null:Number(row.def_ref)
        });
      }

      const topGroupFor=(nodeId:number)=>{
        let current=byId.get(nodeId);
        if(!current)return null;
        let guard=0;
        while(current.parentId!==null&&guard++<64){
          const parent=byId.get(current.parentId);
          if(!parent)break;
          // Mantém o primeiro nível abaixo da raiz federada.
          if(parent.parentId===null)break;
          current=parent;
        }
        return current;
      };

      const rels=await parquetReadObjects({
        file:rf,
        columns:['rel','src','dst'],
        compressors,
        filter:{rel:{$eq:10}},
        usePageIndex:true,
        useBloomFilters:true
      });

      const grouped=new Map<number,{nodeId:number,name:string,objectIndices:number[]}>();
      for(const rel of rels){
        const objectIndex=Number(rel.src),nodeId=Number(rel.dst);
        if(!Number.isFinite(objectIndex)||!Number.isFinite(nodeId))continue;
        const groupNode=topGroupFor(nodeId);
        if(!groupNode)continue;
        let group=grouped.get(groupNode.id);
        if(!group){
          group={nodeId:groupNode.id,name:groupNode.name,objectIndices:[]};
          grouped.set(groupNode.id,group);
        }
        group.objectIndices.push(objectIndex);
      }

      const groups=[...grouped.values()]
        .map(group=>({
          ...group,
          objectIndices:[...new Set(group.objectIndices)],
          count:new Set(group.objectIndices).size
        }))
        .filter(group=>group.count>0)
        .sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name))
        .slice(0,80);

      collectionGroupCache.set(groupKey,{at:Date.now(),groups});
      return json({ok:true,groups,totalGroups:groups.length,source:'bundle-rel10'});
    }

    if(action==='collectionObjectIndices'){
      const nodeId=Number(body.nodeId);
      if(!Number.isFinite(nodeId))throw new Error('nodeId obrigatório.');
      const objectKey=cacheKey(c)+'|collection-objects-v1|'+nodeId;
      const cached=collectionObjectIndexCache.get(objectKey);
      if(cached&&Date.now()-cached.at<30*60*1000){
        return json({
          ok:true,
          nodeId,
          objectIndices:cached.objectIndices,
          count:cached.objectIndices.length,
          descendantCollections:cached.descendantCollections,
          source:'cache'
        });
      }
      const nf=await parquet(data,'.envelope.nodes.parquet');
      const rf=await parquet(data,'.envelope.relations.parquet');
      const nodeRows=await parquetReadObjects({
        file:nf,
        columns:['id','def_ref','kind'],
        compressors,
        filter:{kind:{$eq:7}},
        usePageIndex:true,
        useBloomFilters:true
      });
      const descendants=new Set<number>([nodeId]);
      let changed=true,guard=0;
      while(changed&&guard++<64){
        changed=false;
        for(const row of nodeRows){
          const id=Number(row.id),parent=row.def_ref==null?null:Number(row.def_ref);
          if(Number.isFinite(id)&&parent!==null&&descendants.has(parent)&&!descendants.has(id)){
            descendants.add(id);changed=true;
          }
        }
      }
      const rels=await parquetReadObjects({
        file:rf,
        columns:['rel','src','dst'],
        compressors,
        filter:{rel:{$eq:10}},
        usePageIndex:true,
        useBloomFilters:true
      });
      const objectIndices=[...new Set(
        rels
          .filter((row:any)=>descendants.has(Number(row.dst)))
          .map((row:any)=>Number(row.src))
          .filter(Number.isFinite)
      )].slice(0,100000);
      collectionObjectIndexCache.set(objectKey,{at:Date.now(),objectIndices,descendantCollections:descendants.size});
      return json({ok:true,nodeId,objectIndices,count:objectIndices.length,descendantCollections:descendants.size,source:'bundle-rel10'});
    }

    if(action==='collectionObjectsBatch'){
      const nodeIds=Array.isArray(body.nodeIds)?body.nodeIds.map(Number).filter(Number.isFinite):[];
      const unique=[...new Set(nodeIds)].slice(0,200);
      if(!unique.length)throw new Error('nodeIds obrigatório.');
      const wanted=new Set(unique);
      const rf=await parquet(data,'.envelope.relations.parquet');
      const rels=await parquetReadObjects({file:rf,columns:['rel','src','dst'],compressors,filter:{rel:{$eq:10}},usePageIndex:true,useBloomFilters:true});
      const includeApplicationId=body.includeApplicationId!==false;
      const all=includeApplicationId?await objects(c,data):null;
      const limit=Math.min(100,Math.max(1,Number(body.limit||80)));
      const grouped=new Map<number,number[]>();
      for(const rel of rels){
        const dst=Number(rel.dst),src=Number(rel.src);
        if(!wanted.has(dst)||!Number.isFinite(src))continue;
        const list=grouped.get(dst)||[];
        if(list.length<limit)list.push(src);
        grouped.set(dst,list);
      }
      return json({ok:true,groups:unique.map(nodeId=>({nodeId,objects:(grouped.get(nodeId)||[]).map(i=>({objectIndex:i,applicationId:includeApplicationId?String(all?.[i]?.application_id||i):String(i)}))}))});
    }

    if(action==='collectionObjects'){
      const nodeId=Number(body.nodeId);if(!Number.isFinite(nodeId))throw new Error('nodeId obrigatório.');
      const rf=await parquet(data,'.envelope.relations.parquet');
      const rels=await parquetReadObjects({file:rf,columns:['rel','src','dst'],compressors,filter:{rel:{$eq:10},dst:{$eq:nodeId}},usePageIndex:true,useBloomFilters:true});
      const ids=[...new Set(rels.map((x:any)=>Number(x.src)).filter(Number.isFinite))] as number[];
      const all=await objects(c,data);const limit=Math.min(100,Math.max(1,Number(body.limit||80)));
      return json({ok:true,total:ids.length,objects:ids.slice(0,limit).map(i=>({objectIndex:i,applicationId:String(all[i]?.application_id||i)}))});
    }

    if(action==='search'){
      const q=clean(body.query).toLowerCase();if(!q)return json({ok:true,objects:[]});
      const all=await objects(c,data),result:any[]=[];
      for(const row of all){const id=String(row.application_id||'');if(id.toLowerCase().includes(q)){result.push({objectIndex:Number(row.object_index),applicationId:id});if(result.length>=100)break}}
      return json({ok:true,objects:result});
    }

    if(action==='properties'){
      const all=await objects(c,data);let index=Number(body.objectIndex);
      if(!Number.isFinite(index)&&body.applicationId){const row=all.find((x:any)=>String(x.application_id)===String(body.applicationId));index=Number(row?.object_index)}
      if(!Number.isFinite(index)||!all[index])throw new Error('Objeto não encontrado.');
      const {pathMap}=await paths(c,data);
      const rows=await parquetReadObjects({file:await parquet(data,'.eav.eav.parquet'),compressors,filter:{object_index:{$eq:index}},usePageIndex:true,useBloomFilters:true});
      const props=rows.map((r:any)=>({path:pathMap.get(Number(r.path_index))||String(r.path_index),value:valueOf(r),unit:r.unit||null})).filter((x:any)=>x.value!==null);
      return json({ok:true,object:{objectIndex:index,applicationId:String(all[index].application_id),...derive(props),properties:props}});
    }

    if(action==='renderBatch'){
      const requested=Array.isArray(body.objectIndices)?body.objectIndices.map(Number).filter(Number.isFinite):[];
      const indices=[...new Set(requested)].slice(0,30);
      if(!indices.length)throw new Error('renderBatch requer objectIndices.');
      const all=await objects(c,data);
      const rendered:any[]=[];let meshCount=0;
      for(const index of indices){
        const rows=await geometryRowsForObject(index,data,parquetReadObjects,compressors,16,6*1024*1024);
        if(!rows.length)continue;
        meshCount+=rows.length;
        rendered.push({objectIndex:index,applicationId:String(all[index]?.application_id||index),rows});
        if(meshCount>=80)break;
      }
      return json({ok:true,objects:rendered,objectCount:rendered.length,meshCount});
    }

    if(action==='focusGeometry'){
      const index=Number(body.objectIndex);
      if(!Number.isFinite(index))throw new Error('Object Index obrigatório para foco 3D.');
      const rows=await geometryRowsForObject(index,data,parquetReadObjects,compressors,64,20*1024*1024);
      if(!rows.length)throw new Error('O objeto não possui geometria DISPLAY localizável no Bundle.');
      return json({ok:true,objectIndex:index,rows});
    }
    return json({error:'Operação não implementada.'},200);
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error('speckleBundleApi',message);
    return json({ok:false,error:message},200);
  }
}