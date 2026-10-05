import { secrets } from 'base44:runtime';
export const speckleOrigin = 'https://app.speckle.systems';
export function speckleHeaders(privateAccess) {
  if (!privateAccess) return { 'Content-Type': 'application/json' };
  const token = secrets.get('SPECKLE_TOKEN');
  if (!token) throw new Error('TOKEN NÃO CONFIGURADO. Configure SPECKLE_TOKEN no cofre de segredos.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
export async function speckleGraphql(query, variables, headers) {
  const response = await fetch(`${speckleOrigin}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(25000), redirect: 'manual' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'ERRO DE AUTENTICAÇÃO. Verifique as permissões do token Speckle.' : `Speckle retornou HTTP ${response.status}.`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; ').slice(0, 1200));
  return result.data;
}
export function cleanSpeckleProperties(raw, depth = 0) {
  if (depth > 5 || raw === null) return null;
  if (typeof raw !== 'object') return typeof raw === 'string' ? raw.slice(0, 4000) : raw;
  if (Array.isArray(raw)) return raw.length > 30 ? `[${raw.length} itens]` : raw.map(value => cleanSpeckleProperties(value, depth + 1));
  const omitted = new Set(['displayValue', '@displayValue', '__closure', 'elements', '@elements', 'vertices', 'faces', 'colors', 'textureCoordinates']);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !omitted.has(key)).slice(0, 150).map(([key, value]) => [key, cleanSpeckleProperties(value, depth + 1)]));
}