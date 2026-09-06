export function JarvisMetric({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'live' | 'warn' | 'danger' }) {
  return (
    <div className={`jarvis-metric tone-${tone}`}>
      <span className="jarvis-metric-label">{label}</span>
      <span className="jarvis-metric-value">{value}</span>
    </div>
  );
}
