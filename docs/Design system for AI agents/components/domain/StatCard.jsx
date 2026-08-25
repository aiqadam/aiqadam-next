export function StatCard({ label, value, change, changePositive = true }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        textTransform: 'uppercase', letterSpacing: '0.12em',
        color: 'var(--muted-foreground)',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
        lineHeight: 1, letterSpacing: '-0.03em',
      }}>
        {value}
      </span>
      {change && (
        <span style={{ fontSize: 13, color: changePositive ? 'var(--success)' : 'var(--muted-foreground)' }}>
          {change}
        </span>
      )}
    </div>
  );
}
