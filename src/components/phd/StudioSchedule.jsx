import { useMemo,useState } from 'react';
import { Search, RefreshCw, Download, Play, SkipBack, SkipForward, ChevronDown, CircleAlert, CalendarDays, SlidersHorizontal } from 'lucide-react';
import useModuleRecords from '@/components/phd/useModuleRecords';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

const palette=['#18d17e','#ff974a','#a84df4','#2e8cff','#ffd044','#3ad6e8','#ff5c65','#8b98aa'];
const legend=[['CIV','#18d17e'],['EST','#ff974a'],['MEC','#a84df4'],['TUB','#2e8cff'],['ELE','#ffd044'],['INS','#3ad6e8'],['CAL','#ff5c65']];
const msDay=86400000;
const asDate=v=>v?new Date(v+'T00:00:00'):null;
const pct=(v,min,max)=>max===min?0:Math.max(0,Math.min(100,((v-min)/(max-min))*100));
const shortDate=v=>v||'—';

export default function StudioSchedule({expanded=false,title='WBS + CRONOGRAMA 4D',compact=false}){
  const {items,loading}=useModuleRecords('ScheduleActivity');
  const {project}=useWorkspace();
  const [tab,setTab]=useState('WBS');
  const [query,setQuery]=useState('');
  const [discipline,setDiscipline]=useState('Todas as disciplinas');
  const [period,setPeriod]=useState('Semanal');

  const filtered=useMemo(()=>items.filter(x=>{
    const text=(x.name+' '+x.activity_code+' '+(x.wbs||'')).toLowerCase();
    const matchQuery=text.includes(query.toLowerCase());
    const matchDiscipline=discipline==='Todas as disciplinas'||String(x.wbs||'').toUpperCase().includes(discipline);
    return matchQuery&&matchDiscipline;
  }),[items,query,discipline]);
  const rows=useMemo(()=>filtered.slice(0,expanded?120:9),[filtered,expanded]);
  const bounds=useMemo(()=>{
    const dates=items.flatMap(x=>[asDate(x.start_date)?.getTime(),asDate(x.finish_date)?.getTime()]).filter(Number.isFinite);
    const min=dates.length?Math.min(...dates):Date.now();
    const max=dates.length?Math.max(...dates):Date.now()+90*msDay;
    return {min,max:max===min?min+90*msDay:max};
  },[items]);

  return <section className={"studio-schedule "+(expanded?'expanded ':'')+(compact?'compact':'')}>
    <div className="studio-dock-tabs">
      <strong>{title}</strong>
      {['WBS','GANTT','CURVA S','LOOKAHEAD','RESTRIÇÕES','PROPRIEDADES','COMENTÁRIOS','RECURSOS'].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}
      <span className="dock-spacer"/>
      <select value={period} onChange={e=>setPeriod(e.target.value)}><option>Semanal</option><option>Diário</option><option>Mensal</option></select>
    </div>

    <div className="studio-schedule-toolbar schedule-toolbar-reference">
      <label className="schedule-select-box"><small>LINHA DE BASE</small><button>LB-01 · Plano Original <ChevronDown size={11}/></button></label>
      <label className="schedule-select-box"><small>DATA DE DADOS</small><button><CalendarDays size={12}/>{project?.data_date||'DATA DATE'}</button></label>
      <label className="schedule-select-box discipline-box"><small>FILTRO POR DISCIPLINA</small><select value={discipline} onChange={e=>setDiscipline(e.target.value)}><option>Todas as disciplinas</option>{legend.map(([code])=><option key={code}>{code}</option>)}</select></label>
      <div className="schedule-legend"><small>LEGENDA DE CORES (DISCIPLINA)</small><div>{legend.map(([code,color])=><span key={code}><i style={{background:color}}/>{code}</span>)}</div></div>
      <label className="schedule-search-reference"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar atividade..."/></label>
      <div className="schedule-4d-controls">
        <small>CONTROLES 4D</small>
        <div><button title="Anterior"><SkipBack size={14}/></button><button className="play"><Play size={15}/></button><button title="Próximo"><SkipForward size={14}/></button><span><b>{project?.data_date||'DATA DATE'}</b><em>Semana atual</em></span></div>
      </div>
      <button className="schedule-refresh" title="Atualizar cronograma"><RefreshCw size={13}/><span>Atualizar</span></button>
      <button className="schedule-export" title="Exportar"><Download size={13}/><span>Exportar</span></button>
      <button className="schedule-more" title="Filtros"><SlidersHorizontal size={13}/></button>
    </div>

    <div className="studio-schedule-grid">
      <div className="schedule-table">
        <div className="schedule-head"><span>ID</span><span>NOME DA ATIVIDADE</span><span>TIPO</span><span>INÍCIO</span><span>TÉRMINO</span><span>%</span></div>
        {loading?<div className="schedule-empty">Carregando cronograma…</div>:rows.map((r,i)=><div className={'schedule-row '+(i===3?'selected':'')} key={r.id||i}>
          <span><i style={{background:palette[i%palette.length]}}/>{r.activity_code||'—'}</span>
          <span title={r.name}>{r.name}</span><span>{r.cwp?'CWP':r.cwa?'CWA':'ATV'}</span>
          <span>{shortDate(r.start_date)}</span><span>{shortDate(r.finish_date)}</span><span>{Math.round(Number(r.physical_progress)||0)}%</span>
        </div>)}
        {!loading&&!rows.length&&<div className="schedule-empty"><CircleAlert size={16}/> Nenhuma atividade encontrada.</div>}
      </div>
      <div className="gantt-area">
        <div className="gantt-head"><span>NOV 2026</span><span>DEZ 2026</span><span>JAN 2027</span></div>
        <div className="gantt-ticks">{Array.from({length:12},(_,i)=><i key={i}/>)}</div>
        <div className="today-line" style={{left:`${pct(asDate(project?.data_date)?.getTime()||bounds.min,bounds.min,bounds.max)}%`}}><b>HOJE</b></div>
        {rows.map((r,i)=>{
          const start=asDate(r.start_date)?.getTime()||bounds.min;
          const end=asDate(r.finish_date)?.getTime()||start+7*msDay;
          const left=pct(start,bounds.min,bounds.max);
          const width=Math.max(2,pct(end,bounds.min,bounds.max)-left);
          return <div className={'gantt-row '+(i===3?'selected':'')} key={r.id||i}><i style={{left:left+'%',width:width+'%',background:palette[i%palette.length]}}/></div>;
        })}
      </div>
    </div>
  </section>;
}