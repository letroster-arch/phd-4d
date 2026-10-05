export const nodeId = node => node?.model?.id || '';
export const nodeLabel = node => { const raw = node?.model?.raw || {}; return String(raw.name || raw.Name || raw.applicationId || raw.category || raw.speckle_type?.split('.').pop() || nodeId(node)); };
export const childrenOf = node => (node?.children || []).filter(n => !/^(Objects\.Geometry\.|Speckle\.Core\.Models\.RenderMaterial)/.test(n.model?.raw?.speckle_type || ''));
export function flattenVisible(root, expanded) {
  const result = []; const pending = childrenOf(root).map(node => ({ node, depth: 0 })).reverse();
  while (pending.length) { const entry = pending.pop(); result.push(entry); if (expanded.has(nodeId(entry.node))) { const children = childrenOf(entry.node); for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], depth: entry.depth + 1 }); } }
  return result;
}
export async function searchTree(root, query, cancelled) {
  const results = []; const pending = childrenOf(root).slice(); let n = 0;
  while (pending.length && results.length < 100) { if (cancelled()) return []; const node = pending.pop(); const raw = node.model.raw; if (`${nodeLabel(node)} ${raw?.tag || ''} ${raw?.code || ''} ${nodeId(node)}`.toLowerCase().includes(query.toLowerCase())) results.push({ node, depth: 0 }); pending.push(...childrenOf(node)); if (++n % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0)); }
  return results;
}
export function selectableNode(node) { let current = node; while (current?.parent && /^(Objects\.Geometry\.|Speckle\.Core\.Models\.RenderMaterial)/.test(current.model?.raw?.speckle_type || '')) current = current.parent; return current; }
export function selectedInfo(node) { return node ? { id: nodeId(node), name: nodeLabel(node), node } : null; }