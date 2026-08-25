export function Badge({
  variant = 'default',
  dot = false,
  mono = false,
  children,
  className = '',
}) {
  const variantClass = variant !== 'default' ? `badge-${variant}` : '';
  const cls = ['badge', variantClass, mono ? 'mono' : '', className]
    .filter(Boolean).join(' ');

  return (
    <span className={cls}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}
