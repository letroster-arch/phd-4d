export default function StatusBadge({ status = 'PENDENTE', tone = 'muted' }) {
  return <span className={`status-badge ${tone}`}><span className="status-dot" />{status}</span>;
}