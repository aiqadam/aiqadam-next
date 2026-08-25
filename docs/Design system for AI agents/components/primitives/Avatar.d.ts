export interface AvatarProps {
  /** Two-letter initials (e.g. "AM" for Abdu Muzaffariy) */
  initials?: string;
  /** Photo URL — overrides initials; use sparingly, AI Qadam uses initials by default */
  src?: string;
  /** xs=24 · sm=32 · md=40 · lg=56 · xl=80 · 2xl=120 */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** Shows a green status dot (bottom-right) */
  online?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export interface AvatarGroupProps {
  avatars: Array<{ initials?: string; src?: string }>;
  /** Maximum avatars to show before +N overflow */
  max?: number;
  size?: AvatarProps['size'];
}
