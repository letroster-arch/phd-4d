import { base44 } from '@/api/base44Client';
export async function speckleApi(action, options = {}) {
  const { data } = await base44.functions.invoke('specklePublicApi', { action, ...options });
  if (data.error) throw new Error(data.error);
  return data;
}
export const defaultConnection = { server_url: 'https://app.speckle.systems', auth_method: 'pat', workspace_id: '', project_id: '', project_name: '', model_id: '', model_name: '', version_id: '', referenced_object: '' };