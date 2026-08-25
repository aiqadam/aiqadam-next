export interface SpeakerCardProps {
  speaker: {
    initials: string;
    name: string;
    /** Job title */
    title: string;
    company: string;
    /** Tech tags: ["#LLM", "#RAG"] */
    tags?: string[];
    links?: Array<{ label: string; href: string }>;
  };
}
