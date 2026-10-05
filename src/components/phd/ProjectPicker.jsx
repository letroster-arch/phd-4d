import { useState } from 'react';
import { ChevronsUpDown, Search, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
export default function ProjectPicker() {
  const { project, projects, chooseProject, connection, connections, chooseConnection } = useWorkspace();
  const [search, setSearch] = useState(''); const [open, setOpen] = useState(false);
  const items = (projects.data || []).filter(p => `${p.name} ${p.code || ''}`.toLowerCase().includes(search.toLowerCase()));
  const legacy = (connections.data || []).filter(c => !c.app_project_id && `${c.project_name} ${c.project_id}`.toLowerCase().includes(search.toLowerCase()));
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button className="project-picker" title={project?.name || connection?.project_name || 'Selecionar projeto'}><span><small>PROJETO ATUAL</small><strong>{project?.name || connection?.project_name || connection?.project_id || 'Selecionar projeto'}</strong></span><ChevronsUpDown size={13} /></button></PopoverTrigger><PopoverContent className="technical-popover w-80" align="start"><label className="search-field"><Search size={14} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar projeto..." /></label><div className="max-h-64 overflow-y-auto">{items.map(p => <button key={p.id} className="picker-option" onClick={() => { chooseProject(p.id); setOpen(false); }}>{p.name}{p.code ? ` · ${p.code}` : ''}</button>)}{legacy.map(c => <button key={c.id} className="picker-option" onClick={() => { chooseConnection(c.id); setOpen(false); }}>{c.project_name || c.project_id || c.name} · Speckle</button>)}{!items.length && !legacy.length && <p className="p-4 text-muted-foreground">Nenhum projeto cadastrado.</p>}</div><Link to="/configuracoes" className="picker-option border-t" onClick={() => setOpen(false)}><Settings2 size={14} />Cadastrar projeto / configurar Speckle</Link></PopoverContent></Popover>;
}