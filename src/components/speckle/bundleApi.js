import { base44 } from '@/api/base44Client';

function backendMessage(error) {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.data?.error
    || error?.message
    || 'Falha na integração Bundle/EAV.';
}

export async function bundleApi(action, connection, options = {}) {
  if (!connection?.id) throw new Error('Conexão Speckle não selecionada.');
  try {
    const response = await base44.functions.invoke('speckleBundleApi', {
      action,
      connectionId: connection.id,
      connection: {
        id: connection.id,
        server_url: connection.server_url,
        project_id: connection.project_id,
        model_id: connection.model_id,
        version_id: connection.version_id,
        referenced_object: connection.referenced_object,
        data_format: connection.data_format,
        auth_method: connection.auth_method,
      },
      ...options,
    });
    const data = response?.data ?? response ?? {};
    if (data?.error) throw new Error(data.error);
    return data;
  } catch (error) {
    throw new Error(backendMessage(error));
  }
}
