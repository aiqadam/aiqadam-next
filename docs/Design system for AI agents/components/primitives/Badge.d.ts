export interface BadgeProps {
  /** Controls background/text/border color */
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'destructive';
  /** Adds a small colored dot before the label */
  dot?: boolean;
  /**
   * Applies JetBrains Mono, uppercase, tracking-wide — for status codes:
   * UPCOMING · LIVE · PAST · ONLINE · HACKATHON
   */
  mono?: boolean;
  children?: React.ReactNode;
  className?: string;
}
