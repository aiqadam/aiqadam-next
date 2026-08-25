const AVATAR_COLORS = [
  { bg: 'oklch(0.64 0.13 192)', fg: '#fff' }, /* teal  — A, I */
  { bg: 'oklch(0.60 0.14 270)', fg: '#fff' }, /* purple — B, J */
  { bg: 'oklch(0.63 0.13 225)', fg: '#fff' }, /* blue  — C, K */
  { bg: 'oklch(0.64 0.14 40)',  fg: '#fff' }, /* amber — D, L */
  { bg: 'oklch(0.60 0.15 22)',  fg: '#fff' }, /* red   — E, M */
  { bg: 'oklch(0.61 0.14 300)', fg: '#fff' }, /* violet — F, N */
  { bg: 'oklch(0.63 0.13 155)', fg: '#fff' }, /* green — G, O */
  { bg: 'oklch(0.60 0.12 350)', fg: '#fff' }, /* rose  — H, P */
];

function getAvatarColor(initials) {
  if (!initials) return { bg: 'var(--muted)', fg: 'var(--muted-foreground)' };
  const code = initials.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}

export function Avatar({
  initials,
  src,
  size = 'md',
  online = false,
  className = '',
  style,
}) {
  const sizeClass = {
    xs: 'avatar-xs', sm: 'avatar-sm', md: 'avatar-md',
    lg: 'avatar-lg', xl: 'avatar-xl', '2xl': 'avatar-2xl',
  }[size] || 'avatar-md';

  const color = src ? {} : getAvatarColor(initials);

  const avatarEl = (
    <div
      className={`avatar ${sizeClass} ${className}`.trim()}
      style={{ background: color.bg, color: color.fg, ...style }}
    >
      {src
        ? <img src={src} alt={initials || ''} />
        : (initials || '?')}
    </div>
  );

  if (online) {
    return (
      <div className={`avatar-wrap size-${size}`}>
        {avatarEl}
        <span className="status-dot" />
      </div>
    );
  }

  return avatarEl;
}

export function AvatarGroup({ avatars = [], max = 4, size = 'xs' }) {
  const visible = avatars.slice(0, max);
  const overflow = avatars.length - max;
  const color = getAvatarColor('+');

  return (
    <div className="avatar-group">
      {visible.map((a, i) => (
        <Avatar key={i} initials={a.initials} src={a.src} size={size} />
      ))}
      {overflow > 0 && (
        <div
          className={`avatar avatar-${size}`}
          style={{ background: 'var(--muted)', color: 'var(--muted-foreground)',
                   border: '2px solid var(--card)', fontSize: 10, fontWeight: 500 }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
