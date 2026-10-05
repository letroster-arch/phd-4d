import { useState } from 'react';
import { Activity, RefreshCw, FileText, Terminal } from 'lucide-react';
import StatusBadge from '@/components/phd/StatusBadge';

export default function ConnectionDiagnostics({ diagnostics, log, connection, busy, run }) {
  const [showLog,setShowLog]=useState(false);
  const bundle=diagnostics.artifacts||connection?.data_format==='bundle'||connection?.referenced_object?.startsWith('bundle.');
  const indexed=diagnostics.eav||(bundle&&connection?.status==='ready');
  const hierarchy=diagnostics.hierarchy||indexed;
  const rows=[
    ['API GraphQL',diagnostics.api?'READY':'NÃO TESTADO'],
    ['Autenticação',connection?.auth_method==='public'?'ACESSO PÚBLICO':diagnostics.authentication||'NÃO TESTADO'],
    ['Workspace',diagnostics.workspace?'READY':connection?.workspace_id?'CONFIGURADO':'NÃO VERIFICADO'],
    ['Projeto',diagnostics.project?'READY':connection?.project_id?'CONFIGURADO':'NÃO VERIFICADO'],
    ['Modelo',diagnostics.model?'READY':connection?.model_id?'CONFIGURADO':'NÃO VERIFICADO'],
    ['Versão',diagnostics.version?'READY':connection?.version_id?'CONFIGURADO':'NÃO VERIFICADO'],
    ['Bundle / Artifacts',bundle?'READY':'NÃO VERIFICADO'],
    ['EAV / índice',indexed?'READY':'AGUARDANDO VALIDAÇÃO'],
    ['Viewer',diagnostics.viewer?'READY':'NÃO CARREGADO'],
    ['Hierarquia',hierarchy?'READY':'NÃO CARREGADA'],
    ['Propriedades',indexed?'READY':'SOB DEMANDA'],
  ];
  return <section className="settings-card diagnostics-card">
    <header><Activity size={16}/><h2>DIAGNÓSTICO SPECKLE</h2><span className={'ml-auto status-dot '+(indexed?'ready':'')}/></header>
    <div className="diagnostics-list">{rows.map(([name,status])=><div key={name}><span>{name}</span><StatusBadge status={status} tone={status==='READY'?'ready':status==='CONFIGURADO'||status==='ACESSO PÚBLICO'?'tech':'muted'}/></div>)}</div>
    {diagnostics.objectCount!==undefined&&<div className="sync-details"><span>Objetos indexados</span><strong>{Number(diagnostics.objectCount||0).toLocaleString('pt-BR')}</strong></div>}
    <div className="sync-details"><span>Última sincronização</span><strong>{connection?.last_sync_at?new Date(connection.last_sync_at).toLocaleString('pt-BR'):'Nenhuma sincronização'}</strong><span>Último teste da API</span><strong>{diagnostics.checkedAt?new Date(diagnostics.checkedAt).toLocaleTimeString('pt-BR'):'—'}</strong></div>
    <div className="diagnostics-actions"><button disabled={busy} onClick={()=>run('test')}><RefreshCw size={13}/>Testar novamente</button><button onClick={()=>setShowLog(!showLog)}><FileText size={13}/>{showLog?'Fechar log':'Ver log'}</button></div>
    {showLog&&<div className="diagnostic-log"><strong><Terminal size={13}/>LOG DESTA SESSÃO</strong>{log.length?log.map((line,i)=><p key={i}>{line}</p>):<p>Nenhuma operação executada.</p>}</div>}
  </section>;
}
