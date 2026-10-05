import { useEffect, useMemo, useState } from 'react';
import { Layers3, Loader2, Target } from 'lucide-react';
import { loadBundleCollectionGroups } from '@/components/twin/bundleBrowserGeometry';

const PALETTE=['#1495ff','#22d388','#ffb547','#b56cff','#16c7d9','#ff6b66','#5a7cff','#9fd356','#ff7ab8','#5fd1ff'];

export default function BundleSetsPanel({connection,selected,onSelect,query=''}) {
  const [state,setState]=useState({loading:true,error:'',groups:[]});

  useEffect(()=>{
    let cancelled=false;
    if(!connection?.id){
      setState({loading:false,error:'Modelo não configurado.',groups:[]});
      return;
    }
    setState({loading:true,error:'',groups:[]});
    loadBundleCollectionGroups(connection)
      .then(groups=>{
        if(cancelled)return;
        setState({loading:false,error:'',groups:(groups||[]).map((group,index)=>({
          ...group,
          color:PALETTE[index%PALETTE.length]
        }))});
      })
      .catch(error=>{
        if(!cancelled)setState({loading:false,error:error?.message||'Falha ao carregar Sets.',groups:[]});
      });
    return()=>{cancelled=true};
  },[connection?.id,connection?.version_id]);

  const visible=useMemo(()=>{
    const needle=String(query||'').trim().toLowerCase();
    if(!needle)return state.groups;
    return state.groups.filter(group=>String(group.name||'').toLowerCase().includes(needle));
  },[state.groups,query]);

  if(state.loading)return <div className="bundle-tree-message"><Loader2 size={14} className="animate-spin"/>Montando Sets do modelo…</div>;
  if(state.error)return <div className="bundle-tree-error">{state.error}</div>;
  if(!visible.length)return <div className="bundle-tree-message">Nenhum Set encontrado para este filtro.</div>;

  return <div className="bundle-tree bundle-sets-panel">
    <div className="bundle-set-hint"><Target size={12}/><span>Clique em um Set para isolar e enquadrar. Clique novamente em “Mostrar Tudo” para restaurar.</span></div>
    {visible.map(group=><button
      key={'set-'+group.nodeId}
      className={'bundle-set-row '+(selected?.bundleSet&&selected?.nodeId===group.nodeId?'active':'')}
      onClick={()=>onSelect?.({
        id:'set:'+group.nodeId,
        name:group.name,
        nodeId:group.nodeId,
        objectIndices:group.objectIndices||[],
        count:Number(group.count||0),
        color:group.color,
        bundle:true,
        bundleSet:true
      })}
      title={group.name}
    >
      <i className="bundle-set-swatch" style={{background:group.color}}/>
      <Layers3 size={13}/>
      <span>{group.name}</span>
      <small>{Number(group.count||0).toLocaleString('pt-BR')}</small>
    </button>)}
  </div>;
}
