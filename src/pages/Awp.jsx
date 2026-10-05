import { useMemo,useState } from 'react';
import { Folder, FolderOpen, Search, Upload, Download, Plus, AlertTriangle, Box, Link2, FileText } from 'lucide-react';
import StudioViewer from '@/components/phd/StudioViewer';
import useModuleRecords from '@/components/phd/useModuleRecords';
import { StatusPill, ProgressBar } from '@/components/phd/StudioUI';

export default function Awp(){
  const {items,loading}=useModuleRecords('ScheduleActivity');
  const restrictions=useModuleRecords('Restriction');
  const [selected,setSelected]=useState(null);
  const groups=useMemo(()=>{
    const m={};
    items.forEach(a=>{const cwa=a.cwa||'CWA - NÃO ATRIBUÍDA';const cwp=a.cwp||'CWP - NÃO ATRIBUÍDO';m[cwa]??={};m[cwa][cwp]??=[];m[cwa][cwp].push(a);});
    return m;
  },[items]);
  const row=selected||items[0]||null;
  const openRestrictions=restrictions.items.filter(r=>r.status!=='resolved'&&(!row||!r.activity_id||r.activity_id===row.id));
  const left=<section className="studio-package-panel">
    <header><strong>EXPLORADOR DE PACOTES</strong><span>⌃</span></header>
    <div className="package-actions"><button><Plus size={13}/>Criar Pasta</button><button><Plus size={13}/>Criar Set</button><button><Upload size={13}/>Importar Excel</button><button><Download size={13}/>Exportar Excel</button></div>
    <label className="package-search"><Search size={13}/><input placeholder="Buscar por CWA, CWP, IWP..."/></label>
    <div className="package-tree"><div className="package-tree-head"><span>ESTRUTURA DE PACOTES</span><span>QTD</span></div>
      {loading?<p>Carregando…</p>:Object.entries(groups).map(([cwa,cwps])=><div key={cwa} className="pkg-group"><div className="pkg-cwa"><FolderOpen size={14}/><b>{cwa}</b><em>{Object.values(cwps).flat().length}</em></div>
        {Object.entries(cwps).map(([cwp,rows])=><div key={cwp}><div className="pkg-cwp"><Folder size={13}/><span>{cwp}</span><em>{rows.length}</em></div>{rows.slice(0,8).map((a,i)=><button key={a.id} className={'pkg-iwp '+(row?.id===a.id?'active':'')} onClick={()=>setSelected(a)}><i className={(Number(a.physical_progress)||0)>=100?'ready':(Number(a.physical_progress)||0)>0?'risk':'idle'}/><span>{a.activity_code}</span><em>1</em></button>)}</div>)}
      </div>)}</div>
  </section>;
  const right=<section className="studio-package-detail"><header><strong>DETALHES DO PACOTE</strong><button>×</button></header>{row?<>
    <div className="package-code"><StatusPill>{row.cwp?'IWP':'ATV'}</StatusPill><strong>{row.activity_code}</strong><span>⋮</span></div><h3>{row.name}</h3>
    <dl><div><dt>CWA</dt><dd>{row.cwa||'—'}</dd></div><div><dt>CWP</dt><dd>{row.cwp||'—'}</dd></div><div><dt>DISCIPLINA</dt><dd>{row.wbs||'—'}</dd></div><div><dt>STATUS</dt><dd><StatusPill tone={(Number(row.physical_progress)||0)>=100?'ready':'risk'}>{(Number(row.physical_progress)||0)>=100?'READY':'AT RISK'}</StatusPill></dd></div></dl>
    <div className="detail-progress"><span>PROGRESSO DE PREPARO <b>{Math.round(Number(row.physical_progress)||0)}%</b></span><ProgressBar value={row.physical_progress||0}/></div>
    <dl><div><dt>DATA DE LIBERAÇÃO</dt><dd>{row.start_date||'—'}</dd></div><div><dt>RESPONSÁVEL</dt><dd>Equipe de Campo</dd></div></dl>
    <div className="linked-kpis"><span><Box size={16}/><b>—</b><small>Modelos 3D</small></span><span><FileText size={16}/><b>—</b><small>Documentos</small></span><span><Link2 size={16}/><b>—</b><small>Tags/Links</small></span></div>
    <div className="restriction-kpis"><span><AlertTriangle size={15}/><b>{openRestrictions.length}</b><small>Bloqueantes</small></span><span><AlertTriangle size={15}/><b>0</b><small>Atenção</small></span></div>
    <button className="studio-primary">Abrir Pacote →</button>
  </>:<div className="schedule-empty">Nenhum pacote cadastrado.</div>}</section>;
  const bottom=<section className="awp-bottom-table"><div className="studio-dock-tabs"><button className="active">PACOTES AWP</button><button>SETS DE TRABALHO</button><button>CURVA S</button><button>RESTRIÇÕES</button><button>LOOKAHEAD</button><button>DOCUMENTOS</button><button>EQUIPE</button><button>COMENTÁRIOS</button></div><div className="awp-table-head"><span>CÓDIGO</span><span>DESCRIÇÃO</span><span>CWA</span><span>CWP</span><span>STATUS</span><span>LIBERAÇÃO</span><span>RESPONSÁVEL</span><span>RESTRIÇÕES</span></div>{items.slice(0,8).map(a=><button key={a.id} className="awp-table-row" onClick={()=>setSelected(a)}><span>{a.activity_code}</span><span>{a.name}</span><span>{a.cwa||'—'}</span><span>{a.cwp||'—'}</span><span><StatusPill tone={(Number(a.physical_progress)||0)>=100?'ready':'risk'}>{(Number(a.physical_progress)||0)>=100?'READY':'AT RISK'}</StatusPill></span><span>{a.start_date||'—'}</span><span>Planejamento</span><span>{restrictions.items.filter(r=>r.status!=='resolved'&&r.activity_id===a.id).length}</span></button>)}</section>;
  return <div className="studio-page awp-page"><StudioViewer left={left} right={right} bottom={bottom}/></div>;
}
