import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import '@/components/phd/module.css';

export default function ModulePage({ section, title, description, icon: Icon, children }) {
  const { project, connection } = useWorkspace();
  return <div className="settings-page module-page"><div className="page-breadcrumb">{section}<ChevronRight size={12} /><span>{title.toUpperCase()}</span></div><div className="settings-title"><div><span className="eyebrow">PHD 360 • 4D / {section}</span><h1><Icon size={22} />{title}</h1><p>{description}</p></div><span className="protocol-badge">{project?.name || connection?.project_name || 'SEM PROJETO'}</span></div>{connection?.project_id ? children : <div className="module-empty">Nenhum projeto selecionado. <Link to="/configuracoes">Configurar conexão Speckle</Link> para trabalhar neste módulo.</div>}</div>;
}