export function Tag({ children, className = '' }) {
  return (
    <span className={`tag ${className}`.trim()}>
      {children}
    </span>
  );
}
