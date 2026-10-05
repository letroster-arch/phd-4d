import { NavLink } from 'react-router-dom';
import {
  Home, Box, CalendarDays, ClipboardList, ShieldCheck, BarChart3, Sparkles,
  Settings2, Database, FolderKanban, ChevronsLeft, ChevronsRight
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

const nav=[
  ['Overview',Home,'/executivo'],
  ['Model',Box,'/'],
  ['4D',CalendarDays,'/simulacao-4d'],
  ['AWP',ClipboardList,'/awp'],
  ['Quality',ShieldCheck,'/qualidade'],
  ['Reports',BarChart3,'/controle-do-projeto'],
  ['AI',Sparkles,'/phd-ai']
];

const admin=[
  ['Dados',Database,'/central-de-dados'],
  ['Projetos',FolderKanban,'/projetos'],
  ['Config',Settings2,'/configuracoes']
];

export default function AppSidebar({mobile=false,onNavigate}){
  const {collapsed,setCollapsed}=useWorkspace();

  const item=([label,Icon,path])=>(
    <div className="studio-nav-slot" key={path}>
      <Tooltip>
        <TooltipTrigger asChild>
          <NavLink
            to={path}
            end={path==='/'}
            onClick={onNavigate}
            className={({isActive})=>'studio-nav-item '+(isActive?'active':'')}
            style={{
              position:'relative',
              display:'block',
              width:'100%',
              height:collapsed?58:68,
              minHeight:collapsed?58:68,
              margin:0,
              padding:0,
              overflow:'hidden'
            }}
          >
            <div
              className="studio-nav-inner"
              style={{
                position:'absolute',
                inset:0,
                display:'flex',
                flexDirection:'column',
                alignItems:'center',
                justifyContent:'center',
                gap:collapsed?0:4,
                width:'100%',
                height:'100%',
                textAlign:'center',
                pointerEvents:'none'
              }}
            >
              <Icon size={20} style={{display:'block',flex:'0 0 auto',margin:0}}/>
              {!collapsed&&<span style={{display:'block',width:'100%',fontSize:8,lineHeight:'11px',textAlign:'center',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',padding:'0 5px'}}>{label}</span>}
            </div>
          </NavLink>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <aside
      className={"studio-sidebar "+(mobile?'mobile ':'')+(collapsed?'collapsed':'')}
      style={{
        width:collapsed?58:88,
        minWidth:collapsed?58:88,
        maxWidth:collapsed?58:88,
        display:'flex',
        flexDirection:'column',
        alignItems:'stretch',
        overflow:'hidden'
      }}
    >
      <nav className="studio-nav studio-nav-main" style={{width:'100%',display:'flex',flexDirection:'column',alignItems:'stretch'}}>
        {nav.map(item)}
      </nav>

      <nav className="studio-nav studio-nav-bottom" style={{width:'100%',display:'flex',flexDirection:'column',alignItems:'stretch',marginTop:'auto'}}>
        {admin.map(item)}
        {!mobile&&(
          <button
            className="studio-collapse"
            onClick={()=>setCollapsed(!collapsed)}
            title={collapsed?'Expandir navegação':'Recolher navegação'}
            style={{alignSelf:'center'}}
          >
            {collapsed?<ChevronsRight size={16}/>:<ChevronsLeft size={16}/>}
          </button>
        )}
      </nav>
    </aside>
  );
}