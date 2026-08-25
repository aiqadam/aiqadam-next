export interface LeaderboardMember {
  initials: string;
  name: string;
  /** "@username" */
  username: string;
  /** "Tashkent", "Almaty" */
  country: string;
  /** "🇺🇿", "🇰🇿" */
  countryFlag?: string;
  points: number;
  /** Streak count — renders with 🔥 if > 0 */
  streak?: number;
  /** Position change — positive = moved up, negative = moved down, 0 = no change */
  change?: number;
}

export interface LeaderboardRowProps {
  rank: number;
  member: LeaderboardMember;
}
