import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import '@/components/phd/module.css';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
export default function ProjectRegistration({ isAdmin }) {
  const { project, projects, chooseProject } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState(''); const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const create = async event => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const record = await base44.entities.Project.create({ name: name.trim(), code: code.trim() });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      chooseProject(record.id); setName(''); setCode('');
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <section className="settings-card mb-5 max-w-[1450px]"><header><h2>PROJETO DA PLATAFORMA</h2></header><div className="p-5"><p className="mb-4 muted">Cadastre o projeto antes de associar o modelo Speckle. Projeto atual: <strong className="text-foreground">{project?.name || 'nenhum selecionado'}</strong>.</p>{projects.isLoading && <p>Carregando projetos…</p>}{projects.isError && <p role="alert" className="module-error">{projects.error.message}</p>}{isAdmin && <form onSubmit={create} className="module-toolbar"><label>NOME DO PROJETO<input aria-label="Nome do projeto" value={name} onChange={e => setName(e.target.value)} maxLength={160} required placeholder="Nome do projeto" /></label><label>CÓDIGO<input aria-label="Código do projeto" value={code} onChange={e => setCode(e.target.value)} maxLength={60} placeholder="Opcional" /></label><button className="primary-action" disabled={busy || !name.trim()} type="submit">{busy ? 'Cadastrando…' : 'Cadastrar projeto'}</button></form>}{error && <p role="alert" className="module-error">{error}</p>}</div></section>;
}