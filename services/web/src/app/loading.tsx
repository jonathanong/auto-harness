export default function Loading() {
  return (
    <section aria-labelledby="page-loading-title" aria-busy="true" role="status">
      <h2 id="page-loading-title" className="sr-only">
        Loading page
      </h2>
      <div className="space-y-4" aria-hidden="true">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-lg border bg-muted/60" />
          ))}
        </div>
        <div className="h-48 animate-pulse rounded-lg border bg-muted/60" />
      </div>
    </section>
  );
}
