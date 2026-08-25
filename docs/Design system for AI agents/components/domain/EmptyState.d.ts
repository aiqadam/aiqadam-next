export interface EmptyStateProps {
  /** Icon element — use Lucide at 48px */
  icon?: React.ReactNode;
  heading: string;
  description?: string;
  /** Primary CTA — use <Button variant="primary"> */
  primaryAction?: React.ReactNode;
  /** Secondary CTA — use <Button variant="ghost"> or <Button variant="secondary"> */
  secondaryAction?: React.ReactNode;
}
