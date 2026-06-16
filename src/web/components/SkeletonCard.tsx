/** A shimmer placeholder card shown while the session list is loading. */
export function SkeletonCard() {
  return (
    <article className="card card--skeleton" aria-hidden="true">
      <div className="card__head">
        <span className="sk sk-dot" />
        <span className="sk sk-line sk-line--title" />
      </div>
      <div className="card__meta">
        <span className="sk sk-pill" />
        <span className="sk sk-pill" />
      </div>
      <span className="sk sk-line sk-line--path" />
      <span className="sk sk-line sk-line--repo" />
      <div className="card__actions">
        <span className="sk sk-btn" />
        <span className="sk sk-btn sk-btn--sm" />
      </div>
    </article>
  );
}

/** A grid of skeleton cards. */
export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
