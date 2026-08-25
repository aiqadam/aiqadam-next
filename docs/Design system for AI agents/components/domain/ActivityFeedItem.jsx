import { Avatar } from '../primitives/Avatar.jsx';

export function ActivityFeedItem({ item }) {
  const { initials, action, timestamp, preview } = item;

  return (
    <div style={{ display: 'flex', gap: 12, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
      <Avatar initials={initials} size="sm" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: '0 0 4px', fontSize: 14, lineHeight: 1.4 }}>
          {action}
        </p>
        <time style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' }}>
          {timestamp}
        </time>
        {preview && (
          <div style={{
            marginTop: 10, padding: '10px 14px',
            background: 'var(--muted)', borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', fontSize: 13,
            color: 'var(--muted-foreground)', lineHeight: 1.4,
          }}>
            {preview}
          </div>
        )}
      </div>
    </div>
  );
}
