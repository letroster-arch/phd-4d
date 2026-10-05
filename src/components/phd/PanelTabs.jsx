export default function PanelTabs({ items, value, onChange }) {
  return <div className="panel-tabs" role="tablist">{items.map(item => <button type="button" key={item} role="tab" aria-selected={value === item} className={value === item ? 'active' : ''} onClick={() => onChange(item)}>{item}</button>)}</div>;
}