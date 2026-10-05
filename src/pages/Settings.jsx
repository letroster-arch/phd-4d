import { Settings2, ChevronRight, PlugZap, Save, ShieldCheck, ArrowUpRight, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import ConnectionFields from '@/components/settings/ConnectionFields';
import ProjectRegistration from '@/components/settings/ProjectRegistration';
import ConnectionDiagnostics from '@/components/settings/ConnectionDiagnostics';
import ModelPreparation from '@/components/settings/ModelPreparation';
import useConnectionSettings from '@/components/settings/useConnectionSettings';

export default function Settings() {
  const { project, connection, chooseConnection, modelState } = useWorkspace();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const settings = useConnectionSettings(connection, chooseConnection, project);

  return <div className="settings-page">
    <div className="page-breadcrumb">ADMINISTRAÇÃO<ChevronRight size={12}/>CONFIGURAÇÕES<ChevronRight size={12}/><span>SPECKLE</span></div>

    <div className="settings-title">
      <div>
        <span className="eyebrow">CONEXÕES & INTEGRAÇÕES</span>
        <h1><Settings2 size={22}/>Configurações Speckle</h1>
        <p>Conecte a fonte de dados e prepare cada versão uma única vez para o Digital Twin.</p>
      </div>
      <span className="protocol-badge">SPECKLE → PHD3D</span>
    </div>

    <div className="settings-tabbar"><span className="active">SPECKLE / MODELO 3D</span></div>

    {!isAdmin&&<div className="inline-notice">Somente administradores podem alterar a conexão ou preparar uma nova versão. Você pode consultar o diagnóstico.</div>}
    <ProjectRegistration isAdmin={isAdmin}/>
    {!project&&<p className="inline-notice">Cadastre ou selecione um projeto da plataforma antes de vincular um modelo Speckle.</p>}

    <div className="settings-grid">
      <div className="settings-primary">
        <section className="settings-card">
          <header><PlugZap size={16}/><h2>CONEXÃO DO MODELO</h2><span className="ml-auto muted">01 / CONFIGURAÇÃO</span></header>
          <ConnectionFields {...settings} busy={!!settings.busy} isAdmin={isAdmin}/>
          {settings.message&&<div role="status" className={settings.message.type==='error'?'inline-error':'inline-success'}>{settings.message.text}</div>}
          <footer className="connection-actions">
            <button className="outline-action" disabled={!!settings.busy} onClick={()=>settings.run('test')}>
              {settings.busy==='test'?<Loader2 size={14} className="animate-spin"/>:<PlugZap size={14}/>}Testar API
            </button>
            <button className="outline-action" disabled={!!settings.busy||!isAdmin||!project} onClick={()=>settings.save(false)}>
              <Save size={14}/>Salvar
            </button>
            <button className="primary-action" disabled={!!settings.busy||!isAdmin||!project||!settings.form.referenced_object} onClick={()=>settings.save(true)}>
              Salvar e validar<ArrowUpRight size={14}/>
            </button>
          </footer>
        </section>

        <ModelPreparation connection={connection} isAdmin={isAdmin}/>
      </div>

      <div className="settings-aside">
        <ConnectionDiagnostics
          diagnostics={{
            ...settings.diagnostics,
            workspace:settings.lists.workspaces.some(w=>w.id===settings.form.workspace_id),
            project:settings.lists.projects.some(p=>p.id===settings.form.project_id),
            model:settings.lists.models.some(m=>m.id===settings.form.model_id),
            version:settings.lists.versions.some(v=>v.id===settings.form.version_id),
            viewer:modelState.status==='READY'
          }}
          log={settings.log}
          connection={settings.form}
          busy={!!settings.busy}
          run={settings.run}
        />

        <div className="security-card">
          <ShieldCheck size={21}/>
          <div>
            <h3>SEGURANÇA POR ARQUITETURA</h3>
            <p>Credenciais Speckle continuam protegidas. A geometria processada é armazenada em arquivos privados PHD3D e acessada por URLs assinadas temporárias.</p>
            <span>SPECKLE → PREPARAÇÃO → STORAGE PRIVADO → VIEWER</span>
          </div>
        </div>

        <div className="compatibility-note">
          <strong>SPECKLE 2026.9+</strong>
          <p>O Speckle é a fonte de dados. A versão é preparada uma única vez em chunks PHD3D no storage privado da Base44. O Digital Twin apenas visualiza o cache já processado.</p>
        </div>
      </div>
    </div>
  </div>;
}
