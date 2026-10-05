import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Box, Loader2 } from 'lucide-react';
import { bundleApi } from '@/components/speckle/bundleApi';

export default function BundleTree({ connection, selected, onSelect, query }) {
  const [roots,setRoots]=useState([]);
  const [children,setChildren]=useState({});
  const [objects,setObjects]=useState({});
  const [expanded,setExpanded]=useState(new Set());
  const [busy,setBusy]=useState(new Set());
  const [error,setError]=useState('');
  const [search,setSearch]=useState({busy:false,items:[]});

  const markBusy=(id,on)=>setBusy(prev=>{
    const next=new Set(prev);
    on?next.add(String(id)):next.delete(String(id));
    return next;
  });

  const loadNode=useCallback(async node=>{
    const key=String(node.id);
    if(Object.prototype.hasOwnProperty.call(children,key)&&Object.prototype.hasOwnProperty.call(objects,key))return;
    markBusy(key,true);
    setError('');
    try{
      const [childResult,objectResult]=await Promise.all([
        bundleApi('tree',connection,{parentId:node.id}),
        bundleApi('collectionObjects',connection,{nodeId:node.id,limit:80})
      ]);
      setChildren(value=>({...value,[key]:childResult.nodes||[]}));
      setObjects(value=>({...value,[key]:{
        items:objectResult.objects||[],
        total:Number(objectResult.total||0)
      }}));
    }catch(e){
      setError(e?.message||'Falha ao carregar coleção.');
    }finally{
      markBusy(key,false);
    }
  },[children,objects,connection]);

  useEffect(()=>{
    let cancelled=false;
    setRoots([]);
    setChildren({});
    setObjects({});
    setExpanded(new Set());
    setError('');
    if(!connection?.id)return;

    bundleApi('tree',connection,{parentId:null})
      .then(result=>{
        if(cancelled)return;
        const next=result.nodes||[];
        setRoots(next);
        if(next.length===1){
          setExpanded(new Set([String(next[0].id)]));
          void loadNode(next[0]);
        }
      })
      .catch(e=>!cancelled&&setError(e?.message||'Falha ao carregar hierarquia.'));
    return()=>{cancelled=true};
  },[connection?.id,connection?.version_id]);

  useEffect(()=>{
    let cancelled=false;
    const text=String(query||'').trim();
    if(!text){
      setSearch({busy:false,items:[]});
      return;
    }
    const timer=setTimeout(()=>{
      setSearch({busy:true,items:[]});
      bundleApi('search',connection,{query:text})
        .then(result=>{if(!cancelled)setSearch({busy:false,items:result.objects||[]})})
        .catch(e=>{
          if(!cancelled){
            setSearch({busy:false,items:[]});
            setError(e?.message||'Falha na busca.');
          }
        });
    },220);
    return()=>{cancelled=true;clearTimeout(timer)};
  },[query,connection?.id,connection?.version_id]);

  const toggle=async node=>{
    const key=String(node.id);
    if(expanded.has(key)){
      setExpanded(prev=>{const next=new Set(prev);next.delete(key);return next});
      return;
    }
    setExpanded(prev=>{const next=new Set(prev);next.add(key);return next});
    await loadNode(node);
  };

  const selectCollection=async node=>{
    const key=String(node.id);
    markBusy(key,true);
    setError('');
    try{
      const result=await bundleApi('collectionObjectIndices',connection,{nodeId:node.id});
      onSelect?.({
        id:'collection:'+node.id,
        name:node.name,
        nodeId:Number(node.id),
        objectIndices:result.objectIndices||[],
        count:Number(result.count||0),
        bundle:true,
        bundleCollection:true
      });
    }catch(e){
      setError(e?.message||'Falha ao localizar os objetos da coleção.');
    }finally{
      markBusy(key,false);
    }
  };

  const visible=useMemo(()=>{
    if(String(query||'').trim())return [];
    const rows=[];
    const walk=(nodes,depth)=>{
      for(const node of nodes){
        rows.push({kind:'node',node,depth});
        const key=String(node.id);
        if(expanded.has(key)){
          walk(children[key]||[],depth+1);
          const pack=objects[key];
          for(const obj of pack?.items||[])rows.push({kind:'object',object:obj,depth:depth+1});
          const remaining=Number(pack?.total||0)-Number(pack?.items?.length||0);
          if(remaining>0)rows.push({kind:'more',depth:depth+1,total:remaining,nodeId:node.id});
        }
      }
    };
    walk(roots,0);
    return rows;
  },[roots,children,objects,expanded,query]);

  if(String(query||'').trim()){
    return <div className="bundle-tree bundle-search-results">
      {search.busy&&<div className="bundle-tree-message"><Loader2 size={14} className="animate-spin"/>Buscando no índice EAV…</div>}
      {!search.busy&&search.items.map(item=><button
        key={'search-'+item.objectIndex}
        className={'bundle-object-row '+(selected?.objectIndex===item.objectIndex?'active':'')}
        onClick={()=>onSelect?.({
          id:item.applicationId,
          name:item.applicationId,
          applicationId:item.applicationId,
          objectIndex:item.objectIndex,
          bundle:true
        })}
      ><Box size={12}/><span>{item.applicationId}</span></button>)}
      {!search.busy&&!search.items.length&&<div className="bundle-tree-message">Nenhum objeto encontrado.</div>}
      {error&&<div className="bundle-tree-error">{error}</div>}
    </div>;
  }

  return <div className="bundle-tree">
    {visible.map((row,index)=>{
      if(row.kind==='node'){
        const key=String(row.node.id);
        const open=expanded.has(key);
        const loading=busy.has(key);
        const active=selected?.bundleCollection&&Number(selected?.nodeId)===Number(row.node.id);
        return <div
          className={'bundle-tree-row '+(active?'active':'')}
          key={'node-'+key}
          style={{paddingLeft:8+Math.min(row.depth,8)*14}}
        >
          <button
            className="tree-expander"
            onClick={()=>toggle(row.node)}
            aria-label={open?'Recolher':'Expandir'}
          >{loading?<Loader2 size={11} className="animate-spin"/>:open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>
          <button
            className="tree-node"
            onClick={()=>selectCollection(row.node)}
            title={row.node.name+' · clique para focar · use a seta para expandir'}
          >
            <Folder size={13}/>
            <span>{row.node.name}</span>
            {objects[key]&&<small>{Number(objects[key].total||0).toLocaleString('pt-BR')}</small>}
          </button>
        </div>;
      }

      if(row.kind==='object'){
        const obj=row.object;
        return <div
          className={'bundle-tree-row '+(selected?.objectIndex===obj.objectIndex?'active':'')}
          key={'object-'+obj.objectIndex}
          style={{paddingLeft:8+Math.min(row.depth,8)*14}}
        >
          <span className="tree-expander"/>
          <button
            className="tree-node"
            onClick={()=>onSelect?.({
              id:obj.applicationId,
              name:obj.applicationId,
              applicationId:obj.applicationId,
              objectIndex:obj.objectIndex,
              bundle:true
            })}
            title={obj.applicationId+' · clique para selecionar e aproximar'}
          >
            <Box size={12}/><span>{obj.applicationId}</span>
          </button>
        </div>;
      }

      return <div
        className="bundle-tree-row muted"
        key={'more-'+index}
        style={{paddingLeft:8+Math.min(row.depth,8)*14}}
      >
        <span className="tree-expander"/>
        <span className="bundle-more">+ {row.total.toLocaleString('pt-BR')} objetos nesta coleção</span>
      </div>;
    })}
    {!roots.length&&!error&&<div className="bundle-tree-message"><Loader2 size={14} className="animate-spin"/>Carregando hierarquia Bundle…</div>}
    {error&&<div className="bundle-tree-error">{error}</div>}
  </div>;
}
