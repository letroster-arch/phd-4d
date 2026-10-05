import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, ScanLine, Fingerprint, Box, MapPin, Eye, EyeOff, Focus, Ellipsis, MousePointer2, FileText, Link2 } from 'lucide-react';
import PanelTabs from '@/components/phd/PanelTabs';
import TechnicalButton from '@/components/phd/TechnicalButton';
import PropertyFields from '@/components/twin/PropertyFields';
import { identificationFields, technicalFields, locationFields, namedProperties, flattenProperties } from '@/components/twin/propertyUtils';
import { speckleApi } from '@/components/speckle/speckleApi';
import { bundleApi } from '@/components/speckle/bundleApi';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

export default function ObjectIntelligence({ selected, action }) {
  const [tab,setTab]=useState('GERAL');
  const [more,setMore]=useState(false);
  const { connection }=useWorkspace();
  const bundleMode=connection?.referenced_object?.startsWith('bundle.');

  const properties=useQuery({
    queryKey:['properties',connection?.id,connection?.version_id,bundleMode?selected?.objectIndex:selected?.id],
    queryFn:()=>bundleMode
      ? bundleApi('properties',connection,{objectIndex:selected.objectIndex,applicationId:selected.applicationId})
      : speckleApi('properties',{connectionId:connection.id,projectId:connection.project_id,objectId:selected.id,authMethod:connection.auth_method}),
    enabled:!!connection?.id && (bundleMode?Number.isFinite(Number(selected?.objectIndex)):!!selected?.id),
    staleTime:300000,
    retry:false
  });

  const bundleObject=properties.data?.object||null;
  const raw=bundleMode?bundleObject:(properties.data?.properties||selected?.node?.model?.raw||{});
  const named=useMemo(()=>{
    if(bundleMode){
      if(!bundleObject)return {};
      return {
        ...bundleObject,
        applicationId:bundleObject.applicationId,
        application_id:bundleObject.applicationId,
        modelName:connection?.model_name,
        sourceModel:connection?.model_name
      };
    }
    return namedProperties(raw||{});
  },[bundleMode,bundleObject,raw,connection?.model_name]);
  const attributes=useMemo(()=>{
    if(bundleMode)return (bundleObject?.properties||[]).map(p=>[p.path,p.unit?String(p.value)+' '+p.unit:p.value]);
    return Object.entries(flattenProperties(raw||{}));
  },[bundleMode,bundleObject,raw]);

  const title=bundleObject?.name||bundleObject?.tag||selected?.name||'Objeto BIM';
  const objectId=bundleObject?.applicationId||selected?.applicationId||selected?.id||'';

  return <section className="technical-panel intelligence-panel">
    <header className="panel-heading"><Database size={16}/><div><h2>OBJECT INTELLIGENCE</h2><small>{bundleMode?'Bundle · EAV · Object Index':'Envelope · Object Index'}</small></div><ScanLine size={14} className="ml-auto muted"/></header>
    <PanelTabs items={['GERAL','ATRIBUTOS','VÍNCULOS 4D','DOCUMENTOS']} value={tab} onChange={setTab}/>
    <div className="intelligence-body">
      {!selected
        ? <><div className="object-preview-empty"><div className="object-reticle"><Box size={47} strokeWidth={0.8}/></div><span>NENHUM OBJETO SELECIONADO</span></div><div className="selection-instruction"><MousePointer2 size={17}/><p>Selecione um objeto no modelo<br/>ou na árvore de hierarquia.</p></div>{[[Fingerprint,'IDENTIFICAÇÃO'],[Box,'DADOS TÉCNICOS'],[MapPin,'LOCALIZAÇÃO']].map(([Icon,label])=><div className="empty-property-section" key={label}><Icon size={13}/><strong>{label}</strong><span>—</span></div>)}<div className="object-note"><span className="status-dot"/>Propriedades reais, direto do modelo.</div></>
        : <><div className="selected-object-title"><Box size={20}/><span>{title}<small title={objectId}>{objectId}</small></span></div>{properties.isFetching&&<p className="inline-notice">CARREGANDO PROPRIEDADES EAV…</p>}{properties.isError&&<p className="inline-error">{properties.error.message}</p>}{tab==='GERAL'&&<><PropertyFields title="IDENTIFICAÇÃO" icon={Fingerprint} fields={identificationFields} properties={named}/><PropertyFields title="DADOS TÉCNICOS" icon={Box} fields={technicalFields} properties={named}/><PropertyFields title="LOCALIZAÇÃO" icon={MapPin} fields={locationFields} properties={named}/></>}{tab==='ATRIBUTOS'&&<div className="attribute-list">{attributes.slice(0,350).map(([key,value])=><div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}{!attributes.length&&<p>Sem atributos disponíveis.</p>}</div>}{tab==='VÍNCULOS 4D'&&<div className="panel-empty"><Link2 size={26}/><strong>Vínculos 4D</strong><p>Módulo previsto para a próxima fase.</p></div>}{tab==='DOCUMENTOS'&&<div className="panel-empty"><FileText size={26}/><strong>Sem documentos associados</strong><p>Nenhum documento disponível para este objeto.</p></div>}</>}
    </div>
    <footer className="object-actions"><span>AÇÕES DO OBJETO</span>{bundleMode?<><div><TechnicalButton icon={Eye} label="Isolar seleção no PHD Native Viewer" disabled={!selected} onClick={()=>action('isolate')}>Isolar</TechnicalButton><TechnicalButton icon={Focus} label="Focar objeto no PHD Native Viewer" disabled={!selected} onClick={()=>action('focus')}>Focar</TechnicalButton><TechnicalButton icon={EyeOff} label="Ocultar seleção no PHD Native Viewer" disabled={!selected} onClick={()=>action('hide')}>Ocultar</TechnicalButton><TechnicalButton icon={Ellipsis} label="Mais ações reais" disabled={!selected} onClick={()=>setMore(!more)}/></div>{more&&<div className="extra-object-actions"><button onClick={()=>action('show')}>Mostrar</button><button onClick={()=>action('restore')}>Restaurar filtros</button><button onClick={()=>action('clearColors')}>Limpar cores 4D</button></div>}<small className="bundle-action-note">Renderer nativo ativo: seleção, câmera, visibilidade e cores 4D são controladas diretamente pelo PHD em Three.js.</small></>:<><div><TechnicalButton icon={Eye} label="Isolar seleção" disabled={!selected} onClick={()=>action('isolate')}>Isolar</TechnicalButton><TechnicalButton icon={Focus} label="Focar objeto" disabled={!selected} onClick={()=>action('focus')}>Focar</TechnicalButton><TechnicalButton icon={EyeOff} label="Ocultar objeto" disabled={!selected} onClick={()=>action('hide')}>Ocultar</TechnicalButton><TechnicalButton icon={Ellipsis} label="Mais ações" disabled={!selected} onClick={()=>setMore(!more)}/></div>{more&&<div className="extra-object-actions"><button onClick={()=>action('show')}>Mostrar</button><button onClick={()=>action('transparent')}>Transparência</button><button onClick={()=>action('restore')}>Restaurar</button></div>}</>}</footer>
  </section>;
}