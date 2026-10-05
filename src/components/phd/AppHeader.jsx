import { Search, Bell, ChevronDown, Box, CalendarDays, CheckCircle2, GitBranch, Moon, Sun } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import ProjectPicker from '@/components/phd/ProjectPicker';

const titles={
  '/':'MODELO',
  '/simulacao-4d':'CRONOGRAMA 4D',
  '/awp':'AWP',
  '/controle-do-projeto':'LOOKAHEAD + RESTRIÇÕES',
  '/qualidade':'QUALIDADE DO CRONOGRAMA',
  '/phd-ai':'PHD AI',
  '/executivo':'OVERVIEW',
  '/vinculos-4d':'VÍNCULOS 4D',
  '/central-de-dados':'DADOS',
  '/configuracoes':'CONFIGURAÇÕES',
  '/projetos':'PROJETOS'
};

export default function AppHeader(){
  const {theme,setTheme,project,connection,modelState}=useWorkspace();
  const {user}=useAuth();
  const {pathname}=useLocation();
  const count=modelState.count?.toLocaleString('pt-BR')||'—';
  const ready=modelState.status==='READY'||modelState.status==='CARREGANDO COMPLETO';
  const role=connection?.project_name||'Eng. Planejamento';

  return <header className="studio-header">
    <div className="studio-brand">
      <span className="studio-brand-mark"><Box size={20}/></span>
      <strong>PHD <span>360</span> <b>4D</b></strong>
    </div>

    <div className="studio-workspace-name">DIGITAL CONSTRUCTION WORKSPACE</div>

    <div className="studio-project">
      <GitBranch size={13}/>
      <span className="studio-project-label">PROJETO</span>
      <span className="studio-project-separator">›</span>
      <ProjectPicker/>
      <span className="studio-version">v1.0</span>
    </div>

    <div className="studio-context-title">{titles[pathname]||'PHD 360 4D'}</div>
    <div className="studio-head-stat"><Box size={15}/><span>MODELO CARREGADO<strong>{count} elementos</strong></span></div>
    <div className="studio-head-stat studio-data-date"><CalendarDays size={15}/><span>DATA DE DADOS (DATA DATE)<strong>{project?.data_date||'—'}</strong></span></div>
    <div className={"studio-sync "+(ready?'ready':'')}><CheckCircle2 size={13}/>{ready?'SINCRONIZADO':'STANDBY'}</div>

    <div className="studio-theme-switch" aria-label="Tema do sistema">
      <button className={theme==='dark'?'active':''} onClick={()=>setTheme('dark')} title="Modo Dark"><Moon size={14}/><span>Dark</span></button>
      <button className={theme==='clean'?'active':''} onClick={()=>setTheme('clean')} title="Modo Clean"><Sun size={14}/><span>Clean</span></button>
    </div>

    <button className="studio-icon-button" title="Buscar"><Search size={18}/></button>
    <button className="studio-icon-button" title="Notificações"><Bell size={17}/></button>

    <button className="studio-user">
      <span className="studio-avatar">{(user?.full_name||'ES').slice(0,2).toUpperCase()}</span>
      <span><strong>{user?.full_name||'Usuário'}</strong><small>{role}</small></span>
      <ChevronDown size={13}/>
    </button>
  </header>;
}