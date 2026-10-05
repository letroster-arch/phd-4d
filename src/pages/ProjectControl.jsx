import { useMemo,useState } from 'react';
import { CalendarRange, Plus, Search, Download, ChevronLeft, ChevronRight, List, Columns3 } from 'lucide-react';
import StudioViewer from '@/components/phd/StudioViewer';
import useModuleRecords from '@/components/phd/useModuleRecords';
import { base44 } from '@/api/base44Client';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import { StatusPill, ProgressBar } from '@/components/phd/StudioUI';

const duration=(a,b)=>a&&b?Math.max(1,Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000)+1):0;

export default function ProjectControl(){
  const activities=useModuleRecords('ScheduleActivity');
  const restrictions=useModuleRecords('Restriction');
  const {project}=useWorkspace();
  const [title,setTitle]=useState('');
  const [busy,setBusy]=useState(false);
  const [weeks,setWeeks]=useState(2);
  const byId=useMemo(()=>Object.fromEntries(activities.items.map(a=>[a.id,a])),[activities.items]);
  const open=restrictions.items.filter(r=>r.status!=='resolved');
  const lookahead=activities.items.slice(0,12);
  const add=async()=>{if(!title.trim())return;setBusy(true);try{await base44.entities.Restriction.create({project_id:restrictions.projectId,title:title.trim(),status:'open'});setTitle('');await restrictions.refresh();}finally{setBusy(false)}};

  const right=<section className="restriction-side">
    <header><strong>RESTRIÇÕES EM ABERTO</strong><button>Ver todas</button></header>
    <div className="restriction-side-list">{open.slice(0,7).map((r,i)=><article key={r.id}><input type="checkbox"/><div><strong>{r.title}</strong><span>{r.category||byId[r.activity_id]?.cwp||'PLANEJAMENTO'}</span></div><StatusPill tone={i%3===0?'blocked':i%3===1?'risk':'blue'}>{i%3===0?'ALTA':i%3===1?'MÉDIA':'BAIXA'}</StatusPill></article>)}</div>
    <div className="new-restriction"><input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Nova restrição..."/><button disabled={busy||!title.trim()} onClick={add}><Plus size={14}/> CRIAR RESTRIÇÃO</button></div>
  </section>;

  const bottom=<section className="lookahead-dock">
    <div className="studio-dock-tabs"><button className="active">☷ LOOKAHEAD</button><button>△ RESTRIÇÕES</button><button>⌁ CURVA S</button><button>▥ HISTOGRAMA</button><button>♟ RECURSOS</button><span className="dock-spacer"/><button><Download size={13}/>Exportar</button><select><option>Semanal</option><option>Diário</option></select><button><List size={13}/></button><button><Columns3 size={13}/></button></div>
    <div className="lookahead-toolbar"><label><Search size={13}/><input placeholder="Buscar atividades..."/></label><select><option>Todos os status</option></select><select><option>Todas as disciplinas</option></select><span>Somente com restrições <i className="studio-switch on"/></span></div>
    <div className="lookahead-grid">
      <div className="lookahead-table">
        <div className="lookahead-head"><span>IWP</span><span>DESCRIÇÃO DA ATIVIDADE</span><span>DISCIPLINA</span><span>INÍCIO</span><span>TÉRMINO</span><span>DURAÇÃO</span><span>PREPARO</span><span>RESTRIÇÕES</span><span>RESPONSÁVEL</span><span>STATUS</span><span>⋮</span></div>
        {lookahead.map((a,i)=>{const count=open.filter(r=>r.activity_id===a.id).length;const progress=Math.round(Number(a.physical_progress)||0);const tone=count>1?'blocked':count===1?'risk':'ready';return <div className="lookahead-row" key={a.id}><span>{a.activity_code}</span><span>{a.name}</span><span>{a.wbs||'—'}</span><span>{a.start_date||'—'}</span><span>{a.finish_date||'—'}</span><span>{duration(a.start_date,a.finish_date)}d</span><span><b>{progress}%</b><ProgressBar value={progress} tone={tone}/></span><span>{count}</span><span>{a.responsible||'Planejamento'}</span><span><StatusPill tone={tone}>{tone==='blocked'?'BLOCKED':tone==='risk'?'AT-RISK':'READY'}</StatusPill></span><span>•••</span></div>})}
      </div>
      <aside className="restriction-summary"><strong>RESUMO DE RESTRIÇÕES</strong><div className="donut"><b>{open.length}</b><span>em aberto</span></div><p><i className="red"/>Material <b>{open.filter(r=>/material/i.test(r.category||r.title)).length}</b></p><p><i className="orange"/>Engenharia <b>{open.filter(r=>/engenharia/i.test(r.category||r.title)).length}</b></p><p><i className="blue"/>Acesso / Frente <b>{open.filter(r=>/acesso|frente/i.test(r.category||r.title)).length}</b></p><button>VER TODAS AS RESTRIÇÕES</button></aside>
    </div>
  </section>;

  return <div className="studio-page lookahead-page">
    <div className="lookahead-title lookahead-reference-title">
      <CalendarRange size={17}/><strong>LOOKAHEAD + RESTRIÇÕES</strong>
      <div className="lookahead-period-control"><small>PERÍODO DE LOOKAHEAD</small><select value={weeks} onChange={e=>setWeeks(Number(e.target.value))}><option value={2}>Próximas 2 semanas (14 dias)</option><option value={4}>Próximas 4 semanas (28 dias)</option><option value={6}>Próximas 6 semanas (42 dias)</option></select></div>
      <button className="lookahead-arrow"><ChevronLeft size={13}/></button><button className="lookahead-arrow"><ChevronRight size={13}/></button>
      <span className="lookahead-range">{project?.data_date||'DATA DATE'} → +{weeks*7} dias</span>
      <div className="lookahead-week-buttons">{[2,4,6].map(w=><button key={w} className={weeks===w?'active':''} onClick={()=>setWeeks(w)}>{w}S</button>)}</div>
    </div>
    <StudioViewer right={right} bottom={bottom}/>
  </div>;
}