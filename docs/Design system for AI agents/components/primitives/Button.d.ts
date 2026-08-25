/**
 * Renders a clickable action button. Five variants cover the full intent
 * spectrum from primary CTA to destructive action.
 *
 * @startingPoint section="Components" subtitle="Button — 5 variants, 3 sizes" viewport="700x260"
 */
export interface ButtonProps {
  /** Visual variant — controls fill, border, and color */
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive';
  /** Height: sm = 32px, default = 40px, lg = 44px */
  size?: 'sm' | 'default' | 'lg';
  /** Button label */
  children?: React.ReactNode;
  /** Leading icon element (use Lucide, 16px) */
  icon?: React.ReactNode;
  /** Renders as a square icon-only button; hides children */
  iconOnly?: boolean;
  disabled?: boolean;
  /** Shows a spinner and disables the button while true */
  loading?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  style?: React.CSSProperties;
}
