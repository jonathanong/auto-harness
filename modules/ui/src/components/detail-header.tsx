import type { ReactNode } from "react";
import Link from "next/link";

export type Crumb = {
  label: string;
  /** Omit on the current (last) crumb to render plain text instead of a link. */
  href?: string;
};

/** Breadcrumb trail — last item with no `href` renders as the current page. */
export function Breadcrumbs({ items, pw = "breadcrumbs" }: { items: Crumb[]; pw?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
      data-pw={pw}
    >
      {items.map((item, i) => (
        <span key={`${item.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/50">
              /
            </span>
          ) : null}
          {item.href ? (
            <Link
              href={item.href}
              className="hover:text-foreground hover:underline"
              data-pw={`breadcrumb-${i}`}
            >
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground" data-pw={`breadcrumb-${i}`}>
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export type DetailHeaderProps = {
  breadcrumbs: Crumb[];
  title: ReactNode;
  titlePw?: string;
  /** Buttons rendered in their own row under the title (not beside it). */
  actions?: ReactNode;
};

/** Shared detail-page header: breadcrumb trail, title, then an actions row underneath. */
export function DetailHeader({ breadcrumbs, title, titlePw, actions }: DetailHeaderProps) {
  return (
    <div className="space-y-3">
      <div>
        <Breadcrumbs items={breadcrumbs} />
        <h2 className="text-2xl font-semibold tracking-tight" data-pw={titlePw}>
          {title}
        </h2>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
