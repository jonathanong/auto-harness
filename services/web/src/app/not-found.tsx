import Link from "next/link";

export default function NotFound() {
  return (
    <section className="space-y-3" aria-labelledby="not-found-heading">
      <h2 id="not-found-heading" className="text-2xl font-semibold tracking-tight">
        Page not found
      </h2>
      <p className="text-sm text-muted-foreground">
        This control-plane page does not exist or is no longer available.
      </p>
      <div className="flex gap-4 text-sm">
        <Link href="/" className="font-medium text-primary hover:underline">
          Go to dashboard
        </Link>
        <Link href="/sessions" className="font-medium text-primary hover:underline">
          Browse sessions
        </Link>
      </div>
    </section>
  );
}
