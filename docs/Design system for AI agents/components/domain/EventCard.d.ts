/**
 * The most reused domain pattern in AI Qadam. Shows a single event with
 * date pill, status badge, title, description, meta, tags, and speaker group.
 * Four states: upcoming · live · past · online.
 *
 * @startingPoint section="Domain" subtitle="EventCard — upcoming · live · past · online" viewport="700x260"
 */
export interface EventData {
  /** Short month name — "May" */
  month: string;
  /** Day number — "22" */
  day: string;
  /** Abbreviated weekday — "Fri" */
  weekday: string;
  status: 'upcoming' | 'live' | 'past' | 'online' | 'hackathon';
  title: string;
  description?: string;
  /** "18:30" or "18:30 · Tashkent" */
  time?: string;
  /** "IT Park" or "Zoom · Russian + English" */
  location?: string;
  /** Prefixed tech tags: ["#LLM", "#RAG", "#MLOps"] */
  tags?: string[];
  speakers?: Array<{ initials: string }>;
  /** Registered attendee count (upcoming/past) */
  going?: number;
  /** Live viewer count (live state only) */
  watching?: number;
  /** "14:00 → 18:00 GMT+5" — appended to LIVE badge */
  liveTime?: string;
}

export interface EventCardProps {
  event: EventData;
  onClick?: () => void;
}
