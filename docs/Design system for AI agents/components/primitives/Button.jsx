export function Button({
  variant = 'primary',
  size = 'default',
  children,
  icon,
  iconOnly = false,
  disabled = false,
  loading = false,
  onClick,
  type = 'button',
  className = '',
  style,
  ...props
}) {
  const variantClass = {
    primary:     'btn-primary',
    secondary:   'btn-secondary',
    ghost:       'btn-ghost',
    outline:     'btn-outline',
    destructive: 'btn-destructive',
  }[variant] || 'btn-primary';

  const sizeClass = { sm: 'btn-sm', default: '', lg: 'btn-lg' }[size] || '';

  const cls = ['btn', variantClass, sizeClass, iconOnly ? 'btn-icon' : '', className]
    .filter(Boolean).join(' ');

  const loadingIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ animation: 'aiq-spin 0.75s linear infinite', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );

  return (
    <button type={type} className={cls} disabled={disabled || loading}
      onClick={onClick} style={style} {...props}>
      {loading ? loadingIcon : icon}
      {!iconOnly && children}
    </button>
  );
}
