import { useState } from 'react';
import '@/components/phd/phd.css';
import '@/components/phd/workspace-standard.css';
import '@/components/phd/fourd-redesign.css';
import '@/components/phd/reference-fidelity.css';
import '@/components/phd/reference-v3.css';
import { Outlet } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import WorkspaceContext, { useWorkspace } from '@/components/phd/WorkspaceContext';
import AppHeader from '@/components/phd/AppHeader';
import AppSidebar from '@/components/phd/AppSidebar';

function WorkspaceFrame(){
  const [menuOpen,setMenuOpen]=useState(false);
  const {collapsed}=useWorkspace();
  return <TooltipProvider delayDuration={220}>
    <div className={"phd-app studio-app "+(collapsed?'navigation-collapsed':'')}>
      <AppHeader/>
      <div className="app-body studio-body">
        <div className="desktop-navigation"><AppSidebar/></div>
        <main className="app-main studio-main"><Outlet/></main>
      </div>
    </div>
    <Drawer open={menuOpen} onOpenChange={setMenuOpen}><DrawerContent className="phd-drawer"><DrawerTitle className="sr-only">Navegação</DrawerTitle><AppSidebar mobile onNavigate={()=>setMenuOpen(false)}/></DrawerContent></Drawer>
  </TooltipProvider>;
}

export default function AppLayout(){
  return <WorkspaceContext><WorkspaceFrame/></WorkspaceContext>;
}