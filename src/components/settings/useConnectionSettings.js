import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { speckleApi, defaultConnection } from '@/components/speckle/speckleApi';

const emptyLists=()=>({workspaces:[],projects:[],models:[],versions:[],workspacesCursor:null,projectsCursor:null,modelsCursor:null,versionsCursor:null});

export default function useConnectionSettings(connection,chooseConnection,project){
  const [form,setForm]=useState({...defaultConnection,...connection});
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState(null);
  const [diagnostics,setDiagnostics]=useState({});
  const [log,setLog]=useState([]);
  const [lists,setLists]=useState(emptyLists);
  const queryClient=useQueryClient();

  useEffect(()=>{setForm({...defaultConnection,...connection});setLists(emptyLists());setDiagnostics({})},[connection?.id,project?.id]);
  useEffect(()=>{setLists(emptyLists());setDiagnostics({})},[form.auth_method,form.server_url]);
  useEffect(()=>{setLists(l=>({...l,projects:[],projectsCursor:null,models:[],modelsCursor:null,versions:[],versionsCursor:null}));setDiagnostics(d=>({...d,artifacts:false,eav:false,hierarchy:false}))},[form.workspace_id]);
  useEffect(()=>{setLists(l=>({...l,models:[],modelsCursor:null,versions:[],versionsCursor:null}));setDiagnostics(d=>({...d,artifacts:false,eav:false,hierarchy:false}))},[form.project_id]);
  useEffect(()=>{setLists(l=>({...l,versions:[],versionsCursor:null}));setDiagnostics(d=>({...d,artifacts:false,eav:false,hierarchy:false}))},[form.model_id]);
  useEffect(()=>{setDiagnostics(d=>({...d,artifacts:false,eav:false,hierarchy:false,artifactFiles:[],artifactCount:null}))},[form.version_id]);

  const appendLog=text=>setLog(previous=>[...previous.slice(-49),`${new Date().toLocaleTimeString('pt-BR')}  ${text}`]);

  const purgeOldIntegrationHistory=async(currentRecord)=>{
    const currentProject=String(currentRecord?.project_id||'');
    const currentModel=String(currentRecord?.model_id||'');
    const currentVersion=String(currentRecord?.version_id||'');
    const currentCacheKey=[currentProject,currentModel,currentVersion].join(':');

    // Regra do PHD 360 4D: a base mantém somente a integração 3D atual.
    const connections=await base44.entities.SpeckleConnection.list('-updated_date',100);
    for(const item of connections||[]){
      if(String(item.id)!==String(currentRecord?.id)){
        try{await base44.entities.SpeckleConnection.delete(item.id)}catch{}
      }
    }

    // Remove também registros migrados/legados da configuração.
    // Mantém somente o registro que representa a conexão Speckle atual.
    try{
      const configConnections=await base44.entities.ConfigSpeckleConnection.list('-updated_date',100);
      let keptCurrentConfig=false;
      for(const item of configConnections||[]){
        const sameVersion=
          String(item.project_id||'')===currentProject&&
          String(item.model_id||'')===currentModel&&
          String(item.version_id||'')===currentVersion;
        const linkedToCurrent=String(item.legacy_id||'')===String(currentRecord?.id||'');
        if(!keptCurrentConfig&&(linkedToCurrent||sameVersion&&item.app_project_id)){
          keptCurrentConfig=true;
          continue;
        }
        try{await base44.entities.ConfigSpeckleConnection.delete(item.id)}catch{}
      }
    }catch{}

    const geometryManifests=await base44.entities.GeometryCacheManifest.list('-updated_date',100);
    for(const manifest of geometryManifests||[]){
      if(String(manifest.cache_key||'')===currentCacheKey)continue;
      try{await base44.entities.GeometryCacheChunk.deleteMany({cache_key:String(manifest.cache_key||'')})}catch{}
      try{await base44.entities.GeometryCacheManifest.delete(manifest.id)}catch{}
    }

    const renderManifests=await base44.entities.HyperViewRenderManifest.list('-updated_date',100);
    let keptCurrentRender=false;
    for(const manifest of renderManifests||[]){
      const belongsCurrent=
        String(manifest.project_id||'')===currentProject&&
        String(manifest.model_id||'')===currentModel&&
        String(manifest.version_id||'')===currentVersion;
      if(belongsCurrent&&!keptCurrentRender){
        keptCurrentRender=true;
        continue;
      }
      try{await base44.entities.HyperViewRenderPack.deleteMany({manifest_id:String(manifest.id)})}catch{}
      try{await base44.entities.HyperViewRenderManifest.delete(manifest.id)}catch{}
    }
  };

  useEffect(()=>{
    if(!connection?.id)return;
    void purgeOldIntegrationHistory(connection);
  },[connection?.id,connection?.project_id,connection?.model_id,connection?.version_id]);

  const run=async(action,cursor=null)=>{
    setBusy(action);setMessage(null);
    try{
      const result=await speckleApi(action,{server:form.server_url,authMethod:form.auth_method,workspaceId:form.workspace_id,projectId:form.project_id,modelId:form.model_id,versionId:form.version_id,cursor});
      if(action==='test')setDiagnostics(d=>({...d,api:result.ready,authentication:result.authentication,checkedAt:result.checkedAt}));
      if(['workspaces','projects','models','versions'].includes(action)){
        setLists(current=>{
          const items=Array.from(new Map([...(cursor?current[action]:[]),...(result.items||[])].map(item=>[item.id,item])).values());
          return {...current,[action]:items,[`${action}Cursor`]:result.cursor&&items.length<result.totalCount?result.cursor:null};
        });
        if(action==='projects'&&form.auth_method==='public'&&result.items?.[0])setForm(f=>({...f,project_name:result.items[0].name}));
      }
      if(action==='artifacts'){
        const names=(result.files||[]).map(file=>String(file.name||''));
        const hasEnvelope=names.some(name=>name.endsWith('.envelope.nodes.parquet'))&&names.some(name=>name.endsWith('.envelope.relations.parquet'));
        const hasEav=names.some(name=>name.endsWith('.eav.objects.parquet'))&&names.some(name=>name.endsWith('.eav.paths.parquet'))&&names.some(name=>name.endsWith('.eav.eav.parquet'));
        setDiagnostics(d=>({...d,artifacts:result.available,artifactCount:result.fileCount,artifactFiles:result.files,geometryStream:result.hasGeometryStream,eav:hasEav,hierarchy:hasEnvelope,bundleReady:hasEnvelope&&hasEav}));
      }
      const text=action==='test'
        ? `API GraphQL disponível. Autenticação: ${result.authentication}.`
        : action==='artifacts'
          ? result.note
          : `${result.items?.length||0} resultado(s) obtido(s).`;
      setMessage({text,type:'success'});appendLog(`${action.toUpperCase()} · ${text}`);
    }catch(error){
      const text=error.response?.data?.error||error.message;
      if(action==='test')setDiagnostics(d=>({...d,api:false,authentication:'ERRO DE CONEXÃO'}));
      if(action==='artifacts')setDiagnostics(d=>({...d,artifacts:false,eav:false,hierarchy:false,artifactFiles:[],artifactCount:null}));
      setMessage({text,type:'error'});appendLog(`${action.toUpperCase()} · ERRO · ${text}`);
    }finally{setBusy('')}
  };

  const save=async(load=false)=>{
    setBusy('save');setMessage(null);
    try{
      if(!project)throw new Error('Cadastre ou selecione um projeto da plataforma antes de salvar o modelo.');
      if(form.server_url!=='https://app.speckle.systems')throw new Error('Utilize https://app.speckle.systems.');
      if(load&&(!form.project_id||!form.model_id||!form.version_id||!form.referenced_object))throw new Error('Busque e selecione projeto, modelo e versão antes de carregar.');

      const bundle=form.referenced_object.startsWith('bundle.');
      const payload=Object.fromEntries(Object.keys(defaultConnection).map(key=>[key,form[key]||'']));
      payload.name=form.project_name||form.project_id||'Conexão Speckle';
      payload.app_project_id=project.id;
      payload.data_format=bundle?'bundle':form.referenced_object?'legacy':'';
      payload.status='configured';

      const record=connection?.id&&connection.app_project_id===project.id
        ? await base44.entities.SpeckleConnection.update(connection.id,payload)
        : await base44.entities.SpeckleConnection.create(payload);
      await base44.entities.Project.update(project.id,{speckle_project_id:form.project_id||''});
      await purgeOldIntegrationHistory(record);
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['connections']}),
        queryClient.invalidateQueries({queryKey:['projects']})
      ]);
      chooseConnection(record.id,project.id);
      appendLog('CONFIGURAÇÃO SALVA');

      if(load&&bundle){
        const artifactCheck=await speckleApi('artifacts',{server:form.server_url,authMethod:form.auth_method,projectId:form.project_id,modelId:form.model_id,versionId:form.version_id});
        const names=(artifactCheck.files||[]).map(file=>String(file.name||''));
        const hasEnvelope=names.some(name=>name.endsWith('.envelope.nodes.parquet'))&&names.some(name=>name.endsWith('.envelope.relations.parquet'));
        const hasEav=names.some(name=>name.endsWith('.eav.objects.parquet'))&&names.some(name=>name.endsWith('.eav.paths.parquet'))&&names.some(name=>name.endsWith('.eav.eav.parquet'));
        if(!artifactCheck.available)throw new Error('A versão não retornou artifacts do Speckle.');
        const now=new Date().toISOString();
        await base44.entities.SpeckleConnection.update(record.id,{status:hasEnvelope&&hasEav?'ready':'configured',last_sync_at:now});
        await queryClient.invalidateQueries({queryKey:['connections']});
        setDiagnostics(d=>({...d,artifacts:true,eav:hasEav,hierarchy:hasEnvelope,bundleReady:hasEnvelope&&hasEav,artifactCount:artifactCheck.fileCount}));
        setMessage({type:'success',text:hasEnvelope&&hasEav?'Bundle validado. Agora execute “Sincronizar e preparar modelo 3D” abaixo.':'Artifacts encontrados, mas Envelope/EAV ainda estão incompletos nesta versão.'});
        appendLog(`BUNDLE · ${artifactCheck.fileCount||0} artifacts · Envelope ${hasEnvelope?'READY':'PENDENTE'} · EAV ${hasEav?'READY':'PENDENTE'}`);
        return;
      }

      if(load&&form.auth_method==='pat'){
        setMessage({type:'error',text:'Este modelo é legacy privado. O pipeline autenticado disponível nesta versão é o Bundle 2026.9+.'});
        return;
      }
      setMessage({type:'success',text:form.model_id&&form.version_id?'Modelo vinculado ao projeto. Configuração salva.':'Configuração do projeto salva.'});
    }catch(error){
      setMessage({type:'error',text:error.message});
      appendLog(`SALVAR · ERRO · ${error.message}`);
    }finally{setBusy('')}
  };

  return {form,setForm,busy,message,diagnostics,lists,log,run,save};
}
