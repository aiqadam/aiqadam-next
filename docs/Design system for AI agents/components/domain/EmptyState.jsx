export function EmptyState({ icon, heading, description, primaryAction, secondaryAction }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      textAlign: 'center', padding: '64px 32px', gap: 16,
    }}>
      {icon && (
        <div style={{ color: 'var(--muted-foreground)', marginBottom: 4 }}>
          {icon}
        </div>
      )}
      <h3 style={{
        margin: 0, fontFamily: 'var(--font-display)', fontSize: 18,
        fontWeight: 600, letterSpacing: '-0.01em',
      }}>
        {heading}
      </h3>
      {description && (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--muted-foreground)', maxWidth: 360, lineHeight: 1.55 }}>
          {description}
        </p>
      )}
      {(primaryAction || secondaryAction) && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
