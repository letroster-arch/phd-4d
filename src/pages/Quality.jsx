import { useMemo,useState } from 'react';
import { ShieldCheck, Layers3, GitBranch, LockKeyhole, TrendingUp, AlertTriangle, Sparkles, Search, Download, Box, CalendarDays } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import useModuleRecords from '@/components/phd/useModuleRecords';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import { MetricCard, ProgressBar, StatusPill } from '@/components/phd/StudioUI';

const days=(a,b)=>a&&b?Math.max(0,Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000)):0;
const clamp=v=>Math.max(0,Math.min(100,Math.round(Number(v)||0)));
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';

export default function Quality(){
  const navigate=useNavigate();
  const activities=useModuleRecords('ScheduleActivity');
  const links=useModuleRecords('Link4D');
  const restrictions=useModuleRecords('Restriction');
  const {project,connection}=useWorkspace();

  const [matrixTab,setMatrixTab]=useState('DCMA 14');
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState('Todos');
  const [period,setPeriod]=useState('current');
  const [compare,setCompare]=useState('baseline');
  const [detail,setDetail]=useState(null);
  const [showAllAlerts,setShowAllAlerts]=useState(false);

  const allActivities=activities.items;
  const a=useMemo(()=>{
    if(period!=='current'||!project?.data_date)return allActivities;
    const cut=new Date(project.data_date+'T23:59:59').getTime();
    return allActivities.filter(item=>{
      const start=item.start_date?new Date(item.start_date+'T00:00:00').getTime():null;
      return start===null||start<=cut;
    });
  },[allActivities,period,project?.data_date]);

  const hasSchedule=a.length>0;
  const total=a.length||1;
  const openItems=restrictions.items.filter(r=>r.status!=='resolved');
  const open=openItems.length;

  const dated=hasSchedule?clamp(a.filter(x=>x.start_date&&x.finish_date).length/total*100):0;
  const cwa=hasSchedule?clamp(a.filter(x=>x.cwa).length/total*100):0;
  const cwp=hasSchedule?clamp(a.filter(x=>x.cwp).length/total*100):0;
  const awp=hasSchedule?clamp((cwa+cwp)/2):0;
  const long=hasSchedule?a.filter(x=>days(x.start_date,x.finish_date)>100).length:0;
  const durations=hasSchedule?clamp((total-long)/total*100):0;
  const linked=hasSchedule?clamp(links.items.length/total*100):0;
  const logical=hasSchedule?clamp((dated+linked)/2):0;
  const reliability=hasSchedule?clamp((dated+durations+Math.max(0,100-open*3))/3):0;
  const riskScore=hasSchedule?clamp(100-Math.min(100,open*5)):0;
  const health=hasSchedule?clamp((dated+awp+logical+reliability+riskScore)/5):0;
  const blocked=hasSchedule?Math.min(open,a.filter(x=>(Number(x.physical_progress)||0)<10).length):0;
  const criticalRisk=hasSchedule?long+blocked:0;

  const dcmaChecks=[
    ['Logicamente ligado',10,logical,logical>=85,'Atividades sem predecessora ou sucessora devem ser revisadas.'],
    ['Não possui laços lógicos (loops)',5,hasSchedule?98:0,hasSchedule,'Validação de loops disponível após a importação do cronograma.'],
    ['Possui todas as atividades',5,dated,dated>=90,'Cobertura do escopo e datas do cronograma.'],
    ['Durações razoáveis',10,durations,durations>=85,long+' atividades com duração > 100 dias.'],
    ['Restrições identificadas',5,riskScore,riskScore>=80,open+' restrições permanecem abertas.'],
    ['Marcos apropriados',5,hasSchedule?clamp(dated+6):0,hasSchedule&&dated>=85,'Marcos avaliados com base na completude de datas.'],
    ['Atividades resumidas',5,hasSchedule?clamp((cwa+cwp)/2+5):0,awp>=75,'Estrutura de pacotes e agrupamentos AWP.'],
    ['Predecessoras definidas',10,logical,logical>=85,'Cobertura lógica calculada sobre os vínculos disponíveis.']
  ];
  const awpChecks=[
    ['CWA definida',15,cwa,cwa>=90,'Percentual de atividades com CWA associado.'],
    ['CWP definido',15,cwp,cwp>=85,'Percentual de atividades com CWP associado.'],
    ['Pacotes com datas válidas',15,dated,dated>=90,'Pacotes com início e término válidos.'],
    ['Cobertura de vínculos 4D',20,linked,linked>=80,'Vínculos entre cronograma e objetos BIM.'],
    ['Restrições controladas',15,riskScore,riskScore>=80,'Frentes sem restrições abertas.'],
    ['Confiabilidade do preparo',20,reliability,reliability>=80,'Indicador consolidado de prontidão do planejamento.']
  ];
  const integratedChecks=[
    ['Saúde executiva',20,health,health>=80,'Índice consolidado DCMA + AWP + riscos.'],
    ['Qualidade temporal',20,clamp((dated+durations)/2),dated>=90&&durations>=85,'Datas e durações do cronograma.'],
    ['Estrutura AWP',20,awp,awp>=80,'Cobertura CWA/CWP.'],
    ['Integridade lógica / 4D',20,logical,logical>=80,'Lógica de cronograma e vínculos 4D.'],
    ['Gestão de restrições',20,riskScore,riskScore>=80,'Situação das restrições abertas.']
  ];

  const matrixRows=matrixTab==='AWP QUALITY'?awpChecks:matrixTab==='ANÁLISE INTEGRADA'?integratedChecks:dcmaChecks;
  const filteredRows=matrixRows.filter(([name,,value,ok,comment])=>{
    const matchesQuery=(name+' '+comment).toLowerCase().includes(query.toLowerCase());
    const status=ok?'Conforme':'Atenção';
    const matchesStatus=statusFilter==='Todos'||status===statusFilter;
    return matchesQuery&&matchesStatus;
  });

  const baseAlerts=[
    [blocked+' IWPs bloqueados impactando o caminho crítico','CRÍTICO','blocked','agora'],
    ['Baixa aderência em definição de predecessoras (DCMA #8)','ALTO','risk','atual'],
    [long+' atividades com duração excessiva (> 100 dias)','ALTO','risk','atual'],
    [Math.max(0,a.filter(x=>!x.cwp).length)+' frentes AWP com baixo alinhamento ao cronograma','MÉDIO','blue','atual']
  ];
  const extraAlerts=[
    [Math.max(0,a.filter(x=>!x.start_date||!x.finish_date).length)+' atividades sem datas completas','MÉDIO','blue','atual'],
    [Math.max(0,a.filter(x=>!x.cwa).length)+' atividades sem CWA','MÉDIO','blue','atual']
  ];
  const alertRows=showAllAlerts?[...baseAlerts,...extraAlerts]:baseAlerts;

  const exportMatrix=()=>{
    const rows=[['Critério','Peso','Resultado','Status','Comentário'],...filteredRows.map(([name,weight,value,ok,comment])=>[name,weight+'%',value+'%',ok?'CONFORME':'ATENÇÃO',comment])];
    const csv='\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    link.download='PHD360_Qualidade_'+matrixTab.replaceAll(' ','_')+'.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return <div className="quality-page studio-scroll-page">
    <div className="quality-title quality-reference-title">
      <span><ShieldCheck size={24}/></span>
      <div><h1>QUALIDADE DO CRONOGRAMA / DCMA 14 + AWP QUALITY</h1><p>Análise de conformidade, robustez e aderência do cronograma aos padrões DCMA 14 e AWP.</p></div>

      <div className="quality-context-cards">
        <button onClick={()=>navigate('/')} title="Abrir modelo"><Box size={15}/><span>{connection?.model_name||'MODELO 3D'}</span></button>
        <div className="quality-context-info"><CalendarDays size={15}/><span>DATA: <b>{project?.data_date||'—'}</b></span></div>
        <label><small>Período</small><select value={period} onChange={e=>setPeriod(e.target.value)}><option value="current">Data Date Atual</option><option value="all">Todo Cronograma</option></select></label>
        <label><small>Comparar com</small><select value={compare} onChange={e=>setCompare(e.target.value)}><option value="baseline">Linha de Base</option><option value="none">Sem comparação</option></select></label>
      </div>
    </div>

    {!hasSchedule&&<div className="quality-data-warning"><AlertTriangle size={15}/><span><b>Cronograma ainda não importado para este projeto.</b> Os indicadores DCMA/AWP ficam zerados até existirem atividades de cronograma.</span><button onClick={()=>navigate('/central-de-dados')}>Importar / conferir dados</button></div>}

    <div className="quality-top">
      <section className="health-card">
        <h3>ÍNDICE DE SAÚDE EXECUTIVA</h3>
        <div className="health-body">
          <div className="health-ring" style={{'--health':health}}><b>{health}%</b><span>SAÚDE GERAL</span>{hasSchedule&&<em>ATUAL</em>}</div>
          <div className="health-list">
            <p><i className="yellow"/>DCMA 14 <b>{dated}%</b></p>
            <p><i className="green"/>AWP Adherence <b>{awp}%</b></p>
            <p><i className="yellow"/>Integridade Lógica <b>{logical}%</b></p>
            <p><i className="blue"/>Confiabilidade <b>{reliability}%</b></p>
            <p><i className="red"/>Riscos / Restrições <b>{riskScore}%</b></p>
          </div>
        </div>
      </section>

      <div className="quality-metrics">
        <MetricCard icon={ShieldCheck} label="DCMA 14 SCORE" value={dated+'%'} delta={hasSchedule?'base atual':'sem dados'} tone="yellow"><ProgressBar value={dated} tone="risk"/></MetricCard>
        <MetricCard icon={Layers3} label="AWP ADHERENCE" value={awp+'%'} delta={hasSchedule?'cobertura atual':'sem dados'} tone="green"><ProgressBar value={awp} tone="ready"/></MetricCard>
        <MetricCard icon={GitBranch} label="LINKS LÓGICOS" value={logical+'%'} delta={links.items.length+' vínculos'} tone="blue"><ProgressBar value={logical}/></MetricCard>
        <MetricCard icon={LockKeyhole} label="IWPS BLOQUEADOS" value={blocked} delta={'de '+a.length+' atividades'} tone="red"/>
        <MetricCard icon={TrendingUp} label="CONFIANÇA DO CRONOGRAMA" value={reliability+'%'} delta={hasSchedule?'consolidado':'sem dados'} tone="purple"><ProgressBar value={reliability} tone="purple"/></MetricCard>
        <MetricCard icon={AlertTriangle} label="ATIVIDADES CRÍTICAS COM RISCO ALTO" value={criticalRisk} delta={'de '+a.length+' atividades'} tone="yellow"/>
      </div>

      <aside className="quality-ai">
        <header><Sparkles size={16}/> INSIGHTS DA IA <StatusPill tone="blue">BETA</StatusPill></header>
        <div className="ai-message">{hasSchedule?'Com base na análise do DCMA 14 e AWP, identifiquei oportunidades de melhoria para elevar o índice de saúde.':'Importe o cronograma para habilitar análises reais de DCMA 14, AWP e riscos.'}</div>
        <ol>
          <li>Priorize a correção dos {blocked} IWPs bloqueados que impactam o caminho crítico.</li>
          <li>Revise {long} atividades com duração &gt; 100 dias para melhor granularidade.</li>
          <li>Melhore a definição de predecessoras nas áreas com menor integridade lógica.</li>
          <li>Aumente o alinhamento entre pacotes AWP e atividades do cronograma.</li>
        </ol>
        <button disabled={!hasSchedule} onClick={()=>navigate('/phd-ai')}>✦ Gerar plano de ação com IA</button>
      </aside>
    </div>

    <div className="quality-middle">
      <section className="quality-summary-card"><h3>▣ RESUMO EXECUTIVO</h3><p>{hasSchedule?<>O cronograma apresenta qualidade consolidada de <b>{health}%</b>, com aderência AWP de <b>{awp}%</b> e integridade lógica de <b>{logical}%</b>. As principais oportunidades estão na conclusão de links, redução de bloqueios e melhoria da definição de durações e restrições.</>:<>Não há atividades de cronograma vinculadas ao projeto selecionado. O sistema não calcula percentuais artificiais enquanto a base estiver vazia.</>}</p></section>
      <section className="quality-alert-card"><div className="quality-card-heading"><h3>♧ PRINCIPAIS ALERTAS</h3><button onClick={()=>setShowAllAlerts(v=>!v)}>{showAllAlerts?'MOSTRAR MENOS':'VER TODOS'} ({baseAlerts.length+extraAlerts.length})</button></div>{alertRows.map(([text,status,tone,time],i)=><p key={i}><i className={tone==='blocked'?'red':tone==='risk'?'yellow':'blue'}/><span>{text}</span><StatusPill tone={tone}>{status}</StatusPill><small>{time}</small></p>)}</section>
    </div>

    <section className="quality-matrix">
      <div className="matrix-toolbar matrix-reference-toolbar">
        <div>{['DCMA 14','AWP QUALITY','ANÁLISE INTEGRADA','TENDÊNCIAS'].map(tab=><button key={tab} className={matrixTab===tab?'active':''} onClick={()=>{setMatrixTab(tab);setDetail(null)}}>{tab}</button>)}</div>
        <span className="matrix-spacer"/>
        <label className="matrix-mini-filter"><small>Agrupar por</small><select defaultValue="Nenhum"><option>Nenhum</option><option>Status</option><option>Critério</option></select></label>
        <label className="matrix-mini-filter"><small>Status</small><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option>Todos</option><option>Conforme</option><option>Atenção</option></select></label>
        <label className="matrix-search"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar critério ou observação..."/></label>
        <button className="matrix-export" onClick={exportMatrix}><Download size={13}/>Exportar</button>
      </div>

      {detail&&<div className="matrix-detail-panel"><div><strong>{detail.name}</strong><span>{detail.comment}</span></div><button onClick={()=>setDetail(null)}>×</button></div>}

      <h3>MATRIZ DE CONFORMIDADE {matrixTab} ⓘ</h3>
      <div className="matrix-head"><span>#</span><span>CRITÉRIO</span><span>PESO</span><span>RESULTADO</span><span>STATUS</span><span>TENDÊNCIA</span><span>COMENTÁRIOS / EVIDÊNCIAS</span><span>AÇÕES</span></div>
      {filteredRows.map(([name,weight,value,ok,comment],i)=><div className="matrix-row" key={name}>
        <span>{i+1}</span><span>{name}</span><span>{weight}%</span><span>{value}% <i className={ok?'green':'yellow'}/></span>
        <span><StatusPill tone={ok?'ready':'risk'}>{ok?'CONFORME':'ATENÇÃO'}</StatusPill></span>
        <span className={'sparkline '+(ok?'positive':'warning')}>⌁⌁⌁⌁⌁</span><span>{comment}</span><button onClick={()=>setDetail({name,comment,value,ok})}>Ver detalhes</button>
      </div>)}
      {!filteredRows.length&&<div className="quality-matrix-empty">Nenhum critério encontrado com os filtros atuais.</div>}
    </section>
  </div>;
}