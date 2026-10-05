import { useRef,useState } from 'react';
import ViewerStage from '@/components/twin/ViewerStage';
import HierarchyPanel from '@/components/twin/HierarchyPanel';
import ObjectIntelligence from '@/components/twin/ObjectIntelligence';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

export default function StudioViewer({left,right,bottom,className='',showDefaultInspector=false,overlayRight=false,show4DControls=false}){
  const bridge=useRef(null);
  const [root,setRoot]=useState(null);
  const [selected,setSelected]=useState(null);
  const {modelState}=useWorkspace();
  const action=(name,value)=>bridge.current?.(name,value);
  const selectHierarchy=item=>{
    if(item?.bundleSet||item?.bundleCollection){
      setSelected(item);
      action('selectSet',item);
      return;
    }
    if(item?.model){
      const raw=item.model.raw||{};
      const info={
        id:item.model.id,
        name:String(raw.name||raw.Name||item.model.id),
        node:item,
        bundle:!!raw.bundle,
        bundleCollection:raw.speckle_type==='PHD.Bundle.Collection',
        bundleNodeId:raw.bundleNodeId,
        objectIndex:Number.isFinite(Number(raw.objectIndex))?Number(raw.objectIndex):undefined,
        applicationId:raw.applicationId?String(raw.applicationId):undefined,
        renderSeed:!!raw.renderSeed
      };
      setSelected(info); action('select',info); return;
    }
    setSelected(item); action('select',item);
  };
  const hierarchy=<HierarchyPanel root={root} selected={selected} onSelect={selectHierarchy} loading={modelState.status==='CARREGANDO MODELO'||modelState.status==='CARREGANDO HIERARQUIA'} progress={modelState.progress||0} phase={modelState.phase||''}/>;
  const inspector=<ObjectIntelligence selected={selected} action={action}/>;
  const resolvedRight=typeof right==='function'?right({action,selected,modelState}):right;
  const hasRight=resolvedRight||showDefaultInspector;
  const rightContent=resolvedRight||inspector;
  return <div className={"studio-viewer-shell "+(hasRight&&!overlayRight?'has-right ':'')+(overlayRight?'overlay-right ':'')+className}>
    <div className="studio-left-panel">{left||hierarchy}</div>
    <div className="studio-center-viewer">
      <ViewerStage bridge={bridge} onRoot={setRoot} onSelected={setSelected} selected={selected} openTree={()=>{}} openProperties={()=>{}} show4DControls={show4DControls}/>
      {hasRight&&overlayRight&&<div className="studio-floating-right">{rightContent}</div>}
      {bottom}
    </div>
    {hasRight&&!overlayRight&&<div className="studio-right-panel">{rightContent}</div>}
  </div>;
}
