export interface ActivityFeedItemProps {
  item: {
    initials: string;
    /** Full sentence: "Abdu Muzaffariy registered for AI Qadam #4" */
    action: React.ReactNode;
    /** Relative timestamp: "12 minutes ago", "Yesterday at 18:42" */
    timestamp: string;
    /** Optional embedded content preview (event card snippet, badge, etc.) */
    preview?: React.ReactNode;
  };
}
