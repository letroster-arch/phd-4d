export const identificationFields = [['Nome', ['name', 'Name']], ['Código', ['code', 'Code', 'tag', 'TAG']], ['Disciplina', ['discipline', 'Discipline']], ['Sistema', ['system', 'System']], ['Nível', ['level', 'Level']], ['Modelo de origem', ['sourceModel', 'modelName']], ['GUID', ['guid', 'GUID', 'ifcGuid', 'sourceGuid']], ['Application ID', ['applicationId', 'application_id']], ['Object ID', ['id']]];
export const technicalFields = [['Categoria', ['category', 'Category']], ['Tipo IFC', ['ifcType', 'IfcType']], ['Família', ['family', 'Family']], ['Tipo', ['type', 'Type', 'speckle_type']], ['Fabricante', ['manufacturer', 'Manufacturer']], ['Modelo', ['model', 'Model']], ['Peso', ['weight', 'Weight']], ['Material', ['material', 'Material']], ['Status', ['status', 'Status']], ['Data instalação', ['installationDate']], ['Vida útil', ['serviceLife']]];
export const locationFields = [['Edifício', ['building', 'Building']], ['Área', ['area', 'Area']], ['Setor', ['sector', 'Sector']], ['Nível', ['level', 'Level']], ['CWA', ['cwa', 'CWA']], ['CWP', ['cwp', 'CWP']], ['Zona', ['zone', 'Zone']], ['X', ['x', 'X']], ['Y', ['y', 'Y']], ['Z', ['z', 'Z']]];
export function flattenProperties(object, prefix = '', output = {}, depth = 0) {
  if (!object || depth > 5) return output;
  for (const [key, value] of Object.entries(object)) { if (key.startsWith('__') || ['displayValue', '@displayValue', 'elements', '@elements', 'vertices', 'faces'].includes(key)) continue; const path = prefix ? `${prefix}.${key}` : key; if (value === null) continue; if (typeof value !== 'object') output[path] = value; else if (!Array.isArray(value)) flattenProperties(value, path, output, depth + 1); }
  return output;
}
export function namedProperties(object) {
  const flattened = flattenProperties(object); const result = { ...object };
  for (const [path, value] of Object.entries(flattened)) { const parts = path.split('.'); const key = parts.at(-1) === 'value' ? parts.at(-2) : parts.at(-1); if (result[key] === undefined) result[key] = value; }
  return result;
}