import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Plus, Box, GitBranch, Database, ArrowRight, Settings2, Search, CalendarDays } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

export default function Projects(){
  const { user }=useAuth();
  const { projects,connections,project,chooseProject }=useWorkspace();
  const navigate=useNavigate();
  const queryClient=useQueryClient();
  const [query,setQuery]=useState('');
  const [creating,setCreating]=useState(false);
  const [form,setForm]=useState({name:'',code:'',description:'',data_date:''});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const rows=projects.data||[];
  const links=connections.data||[];

  const filtered=useMemo(()=>{
    const q=query.trim().toLowerCase();
    if(!q)return rows;
    return rows.filter(p=>[p.name,p.code,p.speckle_project_id,p.description].some(v=>String(v||'').toLowerCase().includes(q)));
  },[rows,query]);
  const connectionFor=id=>links.find(c=>c.app_project_id===id)||null;
  const activate=(id,path='/')=>{chooseProject(id);navigate(path)};

  const create=async event=>{
    event.preventDefault();setError('');setBusy(true);
    try{
      const payload={name:form.name.trim(),code:form.code.trim(),description:form.description.trim()};
      if(form.data_date)payload.data_date=form.data_date;
      const record=await base44.entities.Project.create(payload);
      await queryClient.invalidateQueries({queryKey:['projects']});
      chooseProject(record.id);setForm({name:'',code:'',description:'',data_date:''});setCreating(false);
    }catch(e){setError(e.message)}finally{setBusy(false)}
  };

  return <div className="projects-page">
    <div className="projects-head"><div><span className="eyebrow">PORTFÓLIO PHD 360 • 4D</span><h1><FolderKanban size={22}/>Projetos cadastrados</h1><p>Selecione o projeto de trabalho, confira a conexão Speckle e abra o Digital Twin.</p></div>{user?.role==='admin'&&<button className="primary-action" onClick={()=>setCreating(v=>!v)}><Plus size={14}/>{creating?'Fechar cadastro':'Novo projeto'}</button>}</div>
    {creating&&<form className="project-create-card" onSubmit={create}><header><FolderKanban size={15}/><strong>NOVO PROJETO</strong></header><div className="project-form-grid"><label>NOME<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required maxLength={160} placeholder="Nome do projeto"/></label><label>CÓDIGO<input value={form.code} onChange={e=>setForm({...form,code:e.target.value})} maxLength={60} placeholder="Código PHD"/></label><label>DATA DATE<input type="date" value={form.data_date} onChange={e=>setForm({...form,data_date:e.target.value})}/></label><label className="wide">DESCRIÇÃO<input value={form.description} onChange={e=>setForm({...form,description:e.target.value})} maxLength={500} placeholder="Descrição do projeto"/></label></div>{error&&<div className="inline-error">{error}</div>}<footer><button type="button" className="outline-action" onClick={()=>setCreating(false)}>Cancelar</button><button type="submit" className="primary-action" disabled={busy||!form.name.trim()}>{busy?'Cadastrando…':'Cadastrar projeto'}</button></footer></form>}
    <div className="projects-toolbar"><label><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Pesquisar projeto, código ou Speckle ID…"/></label><span><b>{filtered.length}</b> projeto(s)</span></div>
    {projects.isLoading&&<div className="projects-empty">Carregando projetos…</div>}
    {projects.isError&&<div className="inline-error">{projects.error.message}</div>}
    <div className="projects-grid">{filtered.map(p=>{const c=connectionFor(p.id);const active=project?.id===p.id;const ready=c?.status==='ready';return <article className={'project-card '+(active?'active':'')} key={p.id}><header><span className="project-symbol"><FolderKanban size={19}/></span><div><small>{p.code||'SEM CÓDIGO'}</small><h2>{p.name}</h2></div><span className={'project-status '+(ready?'ready':c?'configured':'pending')}><i/>{ready?'READY':c?'CONFIGURADO':'SEM MODELO'}</span></header><div className="project-card-body"><div><Box size={13}/><span>MODELO</span><strong>{c?.model_name||'Não conectado'}</strong></div><div><GitBranch size={13}/><span>VERSÃO</span><strong>{c?.version_id||'—'}</strong></div><div><Database size={13}/><span>SPECKLE PROJECT</span><strong title={c?.project_id||p.speckle_project_id||''}>{c?.project_id||p.speckle_project_id||'—'}</strong></div><div><CalendarDays size={13}/><span>DATA DATE</span><strong>{p.data_date||'—'}</strong></div></div>{p.description&&<p className="project-description">{p.description}</p>}<footer><button className="outline-action" onClick={()=>activate(p.id,'/configuracoes')}><Settings2 size={13}/>Configurar</button><button className="primary-action" onClick={()=>activate(p.id,'/')}><span>{active?'Abrir Digital Twin':'Ativar e abrir'}</span><ArrowRight size={13}/></button></footer></article>})}</div>
    {!projects.isLoading&&!filtered.length&&<div className="projects-empty"><FolderKanban size={30}/><strong>Nenhum projeto encontrado</strong><span>Cadastre o primeiro projeto ou altere a pesquisa.</span></div>}
  </div>;
}
