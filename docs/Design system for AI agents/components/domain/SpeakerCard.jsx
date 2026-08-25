import { Avatar } from '../primitives/Avatar.jsx';
import { Tag } from '../primitives/Tag.jsx';

export function SpeakerCard({ speaker }) {
  const { initials, name, title, company, tags = [], links = [] } = speaker;

  return (
    <div className="card" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <Avatar initials={initials} size="lg" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{
          margin: '0 0 2px',
          fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600,
          letterSpacing: '-0.01em',
        }}>
          {name}
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--muted-foreground)' }}>
          {title}
          <span style={{ color: 'var(--border)', margin: '0 2px' }}>@</span>
          {company}
        </p>
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {tags.map(t => <Tag key={t}>{t}</Tag>)}
          </div>
        )}
        {links.length > 0 && (
          <div style={{ display: 'flex', gap: 14 }}>
            {links.map((l, i) => (
              <a key={i} href={l.href} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 13, color: 'var(--muted-foreground)', textDecoration: 'none' }}>
                {l.label}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
