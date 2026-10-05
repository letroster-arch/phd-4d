import { createContext, useContext, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
const Context = createContext(null);
export const useWorkspace = () => useContext(Context);
export default function WorkspaceContext({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('phd-theme') === 'clean' ? 'clean' : 'dark');
  const [collapsed, setCollapsed] = useState(false);
  const [connectionId, setConnectionId] = useState(() => localStorage.getItem('phd-connection') || '');
  const [projectId, setProjectId] = useState(() => localStorage.getItem('phd-project') || '');
  const [modelState, setModelState] = useState({ status: 'MODELO NÃO CONFIGURADO', count: null });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => base44.entities.Project.list('-created_date', 100), staleTime: 120_000, gcTime: 20 * 60_000 });
  const connections = useQuery({ queryKey: ['connections'], queryFn: async() => (await base44.entities.SpeckleConnection.list('-updated_date', 100)).filter(item=>item.status!=='archived'), staleTime: 120_000, gcTime: 20 * 60_000 });
  const project = projects.data?.find(p => p.id === projectId) || null;
  const connection = projectId ? connections.data?.find(c => c.app_project_id === projectId) || null : connections.data?.find(c => c.id === connectionId) || connections.data?.[0] || null;
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.dataset.theme = theme; localStorage.setItem('phd-theme', theme); }, [theme]);
  const chooseProject = id => { setProjectId(id); localStorage.setItem('phd-project', id); setModelState({ status: 'MODELO NÃO CONFIGURADO', count: null }); };
  const chooseConnection = (id, linkedProjectId = '') => { setConnectionId(id); localStorage.setItem('phd-connection', id); chooseProject(linkedProjectId); };
  return <Context.Provider value={{ theme, setTheme, collapsed, setCollapsed, project, projects, chooseProject, connection, connections, chooseConnection, modelState, setModelState }}>{children}</Context.Provider>;
}