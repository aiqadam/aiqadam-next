export interface TagProps {
  /**
   * Topical/technology tag label. Always prefix with `#`:
   * `#LLM` `#RAG` `#MLOps` `#Computer-Vision` `#Agents`
   */
  children: React.ReactNode;
  className?: string;
}
