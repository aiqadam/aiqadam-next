import { Avatar } from '../primitives/Avatar.jsx';

const RANK_COLOR = { 1: 'var(--badge-gold)', 2: 'var(--badge-silver)', 3: 'var(--badge-bronze)' };

export function LeaderboardHeader() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '40px 1fr 120px 80px 80px 40px',
      gap: 16, padding: '8px 16px',
      borderBottom: '1px solid var(--border)',
      fontFamily: 'var(--font-mono)', fontSize: 11,
      textTransform: 'uppercase', letterSpacing: '0.08em',
      color: 'var(--muted-foreground)',
    }}>
      <span>#</span><span>Member</span><span>Country</span>
      <span>Points</span><span>Streak</span><span>±</span>
    </div>
  );
}

export function LeaderboardRow({ rank, member }) {
  const { initials, name, username, country, countryFlag, points, streak, change } = member;
  const rankColor = RANK_COLOR[rank];
  const changeLabel = change > 0 ? `↑${change}` : change < 0 ? `↓${Math.abs(change)}` : '—';
  const changeColor = change > 0 ? 'var(--success)' : change < 0 ? 'var(--destructive)' : 'var(--muted-foreground)';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '40px 1fr 120px 80px 80px 40px',
      gap: 16, padding: '12px 16px',
      borderBottom: '1px solid var(--border)',
      alignItems: 'center',
    }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: rankColor || 'var(--muted-foreground)' }}>
        {String(rank).padStart(2, '0')}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Avatar initials={initials} size="sm" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' }}>{username}</div>
        </div>
      </div>
      <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>{countryFlag} {country}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>{points.toLocaleString()}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: streak ? 'var(--streak)' : 'var(--muted-foreground)' }}>
        {streak ? `🔥 ${streak}` : '—'}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: changeColor, textAlign: 'right' }}>{changeLabel}</span>
    </div>
  );
}
