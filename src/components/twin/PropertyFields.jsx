import { ChevronDown } from 'lucide-react';
export default function PropertyFields({ title, icon: Icon, fields, properties }) {
  const values = fields.map(([label, keys]) => [label, keys.map(k => properties[k]).find(v => v !== undefined && v !== null && v !== '')]).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object');
  if (!values.length) return null;
  return <section className="property-section"><h3><Icon size={13} />{title}<ChevronDown size={12} className="ml-auto" /></h3><dl>{values.map(([key, value]) => <div className="property-row" key={key}><dt>{key}</dt><dd title={String(value)}>{String(value)}</dd></div>)}</dl></section>;
}