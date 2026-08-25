export interface StatCardProps {
  /** Short uppercase label — "Events attended", "Points", "Talks given" */
  label: string;
  /** Displayed value — number, formatted string, or rank like "#01" */
  value: string | number;
  /** Change annotation — "+3 this quarter", "+125 this week" */
  change?: string;
  /** true = green change text (default), false = muted */
  changePositive?: boolean;
}
