import { AvatarGroup } from '../primitives/Avatar.jsx';
import { Tag } from '../primitives/Tag.jsx';

const STATUS = {
  upcoming:  { label: 'UPCOMING',  color: 'var(--primary)',        bg: 'color-mix(in oklch, var(--primary) 10%, transparent)' },
  live:      { label: 'LIVE',      color: 'var(--live-indicator)', bg: 'color-mix(in oklch, var(--live-indicator) 14%, transparent)' },
  past:      { label: 'PAST',      color: 'var(--muted-foreground)', bg: 'var(--muted)' },
  online:    { label: 'ONLINE',    color: 'var(--primary)',        bg: 'color-mix(in oklch, var(--primary) 10%, transparent)' },
  hackathon: { label: 'HACKATHON', color: 'var(--badge-special)',  bg: 'color-mix(in oklch, var(--badge-special) 12%, transparent)' },
};

export function EventCard({ event, onClick }) {
  const {
    month, day, weekday,
    status = 'upcoming',
    title, description,
    time, location,
    tags = [],
    speakers = [],
    going, watching,
    liveTime,
  } = event;

  const s = STATUS[status] || STATUS.upcoming;
  const isPast = status === 'past';

  return (
    <article
      className="card hoverable"
      style={{
        opacity: isPast ? 0.7 : 1,
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}
      onClick={onClick}
    >
      {/* Date pill + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ textAlign: 'center', minWidth: 44 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted-foreground)' }}>{month}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.025em' }}>{day}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)' }}>{weekday}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {status === 'live' && (
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--live-indicator)', display: 'inline-block', flexShrink: 0 }} />
          )}
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
            textTransform: 'uppercase', letterSpacing: '0.1em',
            padding: '3px 8px', borderRadius: 'var(--radius-sm)',
            background: s.bg, color: s.color,
          }}>
            {s.label}{status === 'live' && liveTime ? ` ${liveTime}` : ''}
          </span>
        </div>
      </div>

      {/* Title + description */}
      <div>
        <h3 style={{ margin: '0 0 6px', fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.015em' }}>
          {title}
        </h3>
        {description && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--muted-foreground)' }}>
            {description}
          </p>
        )}
      </div>

      {/* Time · location */}
      {(time || location) && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--muted-foreground)' }}>
          {[time, location].filter(Boolean).join(' · ')}
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tags.map(t => <Tag key={t}>{t}</Tag>)}
        </div>
      )}

      {/* Footer: speaker avatars + attendance count */}
      {(speakers.length > 0 || going != null || watching != null) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <AvatarGroup avatars={speakers} max={4} size="xs" />
          {going != null && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' }}>
              {going} going
            </span>
          )}
          {watching != null && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--live-indicator)' }}>
              {watching} watching
            </span>
          )}
        </div>
      )}
    </article>
  );
}
