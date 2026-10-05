import { LayoutGrid, CalendarRange, Link2, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import ModulePage from '@/components/phd/ModulePage';
import useModuleRecords from '@/components/phd/useModuleRecords';
export default function Executive() {
  const activities = useModuleRecords('ScheduleActivity'); const links = useModuleRecords('Link4D'); const restrictions = useModuleRecords('Restriction');
  const loading = activities.loading || links.loading || restrictions.loading;
  const error = activities.error || links.error || restrictions.error;
  const open = restrictions.items.filter(item => item.status !== 'resolved').length;
  const progress = activities.items.length ? Math.round(activities.items.reduce((sum, item) => sum + (Number(item.physical_progress) || 0), 0) / activities.items.length) : null;
  return <ModulePage section="EXECUTIVO" title="One Page Executiva" description="Visão consolidada do planejamento, vínculos BIM e restrições do projeto." icon={LayoutGrid}>{loading ? <div className="module-empty">Carregando indicadores…</div> : error ? <div className="module-error">{error.message}</div> : <div className="module-grid"><section className="module-panel"><h2><CalendarRange size={15} />PLANEJAMENTO</h2><strong className="metric">{activities.items.length}</strong><p>atividades · avanço médio: {progress === null ? '—' : `${progress}%`}</p><Link className="module-link" to="/simulacao-4d">Ver simulação por data</Link></section><section className="module-panel"><h2><Link2 size={15} />VÍNCULOS 4D</h2><strong className="metric">{links.items.length}</strong><p>objetos associados a atividades</p><Link className="module-link" to="/vinculos-4d">Ver vínculos</Link></section><section className="module-panel"><h2><ShieldCheck size={15} />CONTROLE DO PROJETO</h2><strong className="metric">{open}</strong><p>restrições abertas</p><Link className="module-link" to="/controle-do-projeto">Ver restrições</Link></section>{(activities.limited || links.limited || restrictions.limited) && <p className="module-alert">Indicadores calculados sobre os primeiros 1.000 registros de cada conjunto.</p>}</div>}</ModulePage>;
}