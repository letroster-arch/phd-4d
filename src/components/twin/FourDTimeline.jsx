import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Link2, Pause, Play } from 'lucide-react';
import { FOUR_D_PHASES } from '@/components/twin/useFourDSimulation';

const dayMs=86400000;
const toDay=value=>Math.floor(new Date(value+'T12:00:00').getTime()/dayMs);
const fromDay=value=>new Date(value*dayMs).toISOString().slice(0,10);

export default function FourDTimeline({simulation,enabled,onEnabledChange}){
  const [playing,setPlaying]=useState(false);
  const hasLinks=Number(simulation.linkedWithGeometryIndex||0)>0;
  const minDay=useMemo(()=>toDay(simulation.minDate),[simulation.minDate]);
  const maxDay=useMemo(()=>Math.max(minDay,toDay(simulation.maxDate)),[simulation.maxDate]);
  const valueDay=Math.min(maxDay,Math.max(minDay,toDay(simulation.date)));

  useEffect(()=>{
    if(!playing||!enabled||maxDay<=minDay)return;
    const timer=setInterval(()=>{
      const current=toDay(simulation.date);
      if(current>=maxDay){
        setPlaying(false);
        return;
      }
      simulation.setDate(fromDay(current+1));
    },550);
    return()=>clearInterval(timer);
  },[playing,enabled,maxDay,minDay,simulation.date,simulation.setDate]);

  const move=days=>{
    const next=Math.max(minDay,Math.min(maxDay,valueDay+days));
    simulation.setDate(fromDay(next));
  };

  return <div className="four-d-timeline">
    <div className="four-d-head">
      <span><CalendarDays size={12}/>SIMULAÇÃO 4D AUTOMÁTICA</span>
      <button className={'four-d-toggle '+(enabled&&hasLinks?'active':'')} disabled={!hasLinks} onClick={()=>hasLinks&&onEnabledChange(!enabled)}>{hasLinks?(enabled?'ATIVA':'PAUSADA'):'SEM VÍNCULO'}</button>
    </div>
    <div className="four-d-controls">
      <button onClick={()=>move(-1)} disabled={!hasLinks||!enabled||valueDay<=minDay} aria-label="Dia anterior"><ChevronLeft size={14}/></button>
      <button onClick={()=>setPlaying(value=>!value)} disabled={!hasLinks||!enabled||simulation.loading||maxDay<=minDay} aria-label={playing?'Pausar':'Reproduzir'}>{playing?<Pause size={14}/>:<Play size={14}/>}</button>
      <input type="date" value={simulation.date} min={simulation.minDate} max={simulation.maxDate} onChange={e=>simulation.setDate(e.target.value)} disabled={!hasLinks||!enabled}/>
      <input className="four-d-range" type="range" min={minDay} max={maxDay} value={valueDay} onChange={e=>simulation.setDate(fromDay(Number(e.target.value)))} disabled={!hasLinks||!enabled||maxDay<=minDay}/>
      <button onClick={()=>move(1)} disabled={!hasLinks||!enabled||valueDay>=maxDay} aria-label="Próximo dia"><ChevronRight size={14}/></button>
    </div>
    <div className="four-d-legend">
      {FOUR_D_PHASES.map(item=><span key={item.key}><i style={{background:item.color}}/>{item.label}<strong>{simulation.counts?.[item.key]||0}</strong></span>)}
    </div>
    <div className="four-d-meta">
      <span><Link2 size={10}/>{simulation.links.length} vínculos · {simulation.linkedWithGeometryIndex} com Object Index</span>
      {simulation.loading&&<span>ATUALIZANDO…</span>}
      {simulation.error&&<span className="error">{simulation.error.message}</span>}
      {!simulation.loading&&!hasLinks&&<span>SEM VÍNCULO 4D · CORES ORIGINAIS DO MODELO</span>}
    </div>
  </div>;
}
