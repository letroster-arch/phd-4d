import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import { speckleOrigin, speckleHeaders, speckleGraphql, cleanSpeckleProperties } from '../../shared/speckleGateway.ts';
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Autenticação necessária.' }, { status: 401 });
    const body = await req.json();
    const { action, modelId, objectId, workspaceId, cursor, versionId } = body;
    let projectId = body.projectId;
    if (body.server && body.server !== speckleOrigin) return Response.json({ error: `Utilize o servidor oficial ${speckleOrigin}.` }, { status: 400 });
    if (body.authMethod && !['public', 'pat'].includes(body.authMethod)) return Response.json({ error: 'Método de autenticação inválido.' }, { status: 400 });
    const privateAccess = body.authMethod !== 'public';
    if (!['test', 'workspaces', 'projects', 'models', 'versions', 'properties', 'artifacts'].includes(action)) return Response.json({ error: 'Operação inválida.' }, { status: 400 });
    if (privateAccess && !['test', 'properties'].includes(action) && user.role !== 'admin') return Response.json({ error: 'Somente administradores podem consultar o catálogo privado Speckle.' }, { status: 403 });
    if (action === 'properties' && privateAccess) {
      if (!body.connectionId || typeof body.connectionId !== 'string' || body.connectionId.length > 100) return Response.json({ error: 'Selecione uma conexão autorizada do aplicativo.' }, { status: 400 });
      const connection = await base44.entities.SpeckleConnection.get(body.connectionId);
      if (!connection || connection.server_url !== speckleOrigin || connection.auth_method !== 'pat') return Response.json({ error: 'Conexão privada não autorizada.' }, { status: 403 });
      if (connection.referenced_object?.startsWith('bundle.')) return Response.json({ error: 'BUNDLE 2026.9: a consulta de propriedades requer o índice EAV, ainda não implementado.' });
      projectId = connection.project_id;
    }
    for (const id of [projectId, modelId, objectId, workspaceId, versionId]) if (id !== undefined && id !== '' && (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,180}$/.test(id))) return Response.json({ error: 'Identificador inválido.' }, { status: 400 });
    if (cursor && (typeof cursor !== 'string' || cursor.length > 500)) return Response.json({ error: 'Cursor inválido.' }, { status: 400 });
    if (['models', 'versions', 'properties', 'artifacts'].includes(action) && !projectId) return Response.json({ error: 'Selecione um projeto.' }, { status: 400 });
    if (['versions', 'artifacts'].includes(action) && !modelId) return Response.json({ error: 'Selecione um modelo.' }, { status: 400 });
    if (action === 'properties' && !objectId) return Response.json({ error: 'Selecione um objeto.' }, { status: 400 });
    if (action === 'workspaces' && !privateAccess) return Response.json({ error: 'A consulta de workspaces exige autenticação protegida.' }, { status: 400 });
    if (action === 'projects' && !privateAccess && !projectId) return Response.json({ error: 'Informe o ID do projeto público.' }, { status: 400 });
    const headers = speckleHeaders(privateAccess);
    if (action === 'artifacts') {
      if (!versionId) return Response.json({ error: 'Selecione uma versão.' }, { status: 400 });
      const response = await fetch(`${speckleOrigin}/api/v2/projects/${projectId}/models/${modelId}/versions/${versionId}/artifacts`, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      if (!response.ok) return Response.json({ error: `Artifacts indisponíveis (HTTP ${response.status}). Verifique a versão e as permissões.` });
      const result = await response.json();
      const files = Array.isArray(result.files) ? result.files.map(file => ({ name: String(file.name || '').slice(0, 500) })) : [];
      const names = files.map(file => file.name);
      const hasEnvelope = names.some(name => name.endsWith('.envelope.nodes.parquet')) && names.some(name => name.endsWith('.envelope.relations.parquet'));
      const hasEav = names.some(name => name.endsWith('.eav.objects.parquet')) && names.some(name => name.endsWith('.eav.paths.parquet')) && names.some(name => name.endsWith('.eav.eav.parquet'));
      return Response.json({ available: files.length > 0, format: 'bundle', files: files.slice(0, 100), fileCount: files.length, hasEnvelope, hasEav, bundleReady: hasEnvelope && hasEav, hasGeometryStream: typeof result.geometryStream?.path === 'string', checkedAt: new Date().toISOString(), note: hasEnvelope && hasEav ? `${files.length} artifacts detectados. Envelope e EAV prontos.` : `${files.length} artifacts detectados. Bundle parcial: Envelope/EAV incompletos.` });
    }
    const queries = {
      test: `query { serverInfo { name version } ${privateAccess ? 'activeUser { id }' : ''} }`,
      workspaces: 'query($cursor:String){activeUser{workspaces(limit:50,cursor:$cursor){items{id name} cursor totalCount}}}',
      projects: !privateAccess ? 'query($projectId:String!){project(id:$projectId){id name description}}' : workspaceId ? 'query($workspaceId:String!,$cursor:String){workspace(id:$workspaceId){projects(limit:50,cursor:$cursor){items{id name description} cursor totalCount}}}' : 'query($cursor:String){activeUser{projects(limit:50,cursor:$cursor){items{id name description} cursor totalCount}}}',
      models: 'query($projectId:String!,$cursor:String){project(id:$projectId){models(limit:50,cursor:$cursor){items{id name description} cursor totalCount}}}',
      versions: 'query($projectId:String!,$modelId:String!,$cursor:String){project(id:$projectId){model(id:$modelId){versions(limit:50,cursor:$cursor){items{id message referencedObject createdAt sourceApplication} cursor totalCount}}}}',
      properties: 'query($projectId:String!,$objectId:String!){project(id:$projectId){object(id:$objectId){id data}}}'
    };
    if (objectId?.startsWith('bundle.')) return Response.json({ error: 'BUNDLE 2026.9: utilize o índice EAV, não o endpoint de objetos legacy.' });
    const data = await speckleGraphql(queries[action], { projectId, modelId, objectId, workspaceId, cursor: cursor || null }, headers);
    if (action === 'test') {
      const authenticated = privateAccess && !!data.activeUser?.id;
      if (privateAccess && !authenticated) return Response.json({ error: 'ERRO DE AUTENTICAÇÃO. O token não identificou um usuário Speckle.' }, { status: 401 });
      return Response.json({ ready: true, server: data.serverInfo, checkedAt: new Date().toISOString(), authentication: authenticated ? 'READY' : 'ACESSO PÚBLICO' });
    }
    if (action === 'workspaces') return Response.json(data.activeUser?.workspaces || { error: 'Token sem permissão para workspaces.' });
    if (action === 'projects') {
      if (!privateAccess) return Response.json(data.project ? { items: [data.project], cursor: null, totalCount: 1 } : { error: 'Projeto não encontrado ou sem acesso público.' });
      return Response.json((workspaceId ? data.workspace?.projects : data.activeUser?.projects) || { error: 'Catálogo de projetos indisponível para este token.' });
    }
    if (!data.project) return Response.json({ error: 'Projeto não encontrado ou sem permissão de acesso.' });
    if (action === 'models') return Response.json(data.project.models);
    if (action === 'versions') return Response.json(data.project.model?.versions || { error: 'Modelo não encontrado.' });
    const raw = data.project.object?.data;
    return Response.json(raw ? { properties: cleanSpeckleProperties(raw) } : { error: 'Objeto não encontrado ou propriedades indisponíveis.' });
  } catch (error) { return Response.json({ error: error.message || 'Falha na comunicação com Speckle.' }, { status: 500 }); }
}