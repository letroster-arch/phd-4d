import { useState } from 'react';
import { Network, Search, SlidersHorizontal, Layers3, ChevronRight, Database } from 'lucide-react';
import { Link } from 'react-router-dom';
import PanelTabs from '@/components/phd/PanelTabs';
import VirtualTree from '@/components/twin/VirtualTree';
import BundleTree from '@/components/twin/BundleTree';
import BundleSetsPanel from '@/components/twin/BundleSetsPanel';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

const TABS=['HIERARCHY','SETS'];

export default function HierarchyPanel({ root, selected, onSelect, loading, progress=0, phase='' }) {
  const [tab,setTab]=useState('HIERARCHY');
  const [query,setQuery]=useState('');
  const { connection }=useWorkspace();
  const bundleMode=connection?.referenced_object?.startsWith('bundle.');
  const structure=root
    ? <VirtualTree root={root} selected={selected} onSelect={onSelect} query={query}/>
    : bundleMode
      ? <BundleTree connection={connection} selected={selected} onSelect={onSelect} query={query}/>
      : null;

  return <section className="technical-panel hierarchy-panel">
    <header className="panel-heading"><Network size={14}/><h2>MODEL EXPLORER</h2><Database size={13} className="ml-auto muted"/></header>
    <PanelTabs items={TABS} value={tab} onChange={setTab}/>
    <div className="hierarchy-search">
      <label className="search-field"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar no modelo..." aria-label="Buscar no modelo"/></label>
      <button className="hierarchy-filter-button" title="Filtros"><SlidersHorizontal size={14}/></button>
    </div>
    {loading
      ? <div className="panel-empty"><span className="small-loader"/><p>CARREGANDO HIERARQUIA · {Math.round(Number(progress||0))}%</p>{phase&&<small>{phase}</small>}<div className="hierarchy-load-progress"><i style={{width:Math.max(0,Math.min(100,Number(progress||0)))+'%'}}/></div></div>
      : tab==='HIERARCHY'&&structure
        ? structure
        : tab==='SETS'&&bundleMode
          ? <BundleSetsPanel connection={connection} selected={selected} onSelect={onSelect} query={query}/>
          : <div className="panel-empty hierarchy-empty"><div className="empty-tree-symbol"><Layers3 size={29} strokeWidth={1}/></div><strong>Nenhum modelo conectado</strong><p>A estrutura completa do modelo será exibida aqui.</p><div className="hierarchy-diagram" aria-hidden="true"><span/><i/><span/><i/><span/></div>{!structure&&<Link to="/configuracoes">Configurar modelo<ChevronRight size={12}/></Link>}</div>}
    <footer className="panel-footer"><span>{tab==='SETS'?'SETS DO BUNDLE':bundleMode&&root?'WORLDTREE BUNDLE':bundleMode?'HIERARQUIA BUNDLE / EAV':root?'HIERARQUIA DO VIEWER':'SEM OBJETOS'}</span><span>{bundleMode&&root?'LOCAL':bundleMode?'API':'VIRTUALIZADA'}</span></footer>
  </section>;
}