export interface EmptyStateProps {
  readonly title: string;
  readonly message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="pp-card pp-empty" role="status">
      <h3 className="pp-empty-title">{title}</h3>
      <p className="pp-muted">{message}</p>
    </div>
  );
}
