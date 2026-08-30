import Link from "next/link";

import type { DashboardPagination } from "@/lib/dashboard-api";

export function LedgerPagination({
  pagination,
  pathname,
  values,
}: {
  pagination: DashboardPagination;
  pathname: string;
  values: Record<string, string | undefined>;
}) {
  if (pagination.totalPages <= 1) return null;
  const hrefFor = (page: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
    query.set("page", String(page));
    return `${pathname}?${query.toString()}`;
  };
  return (
    <nav className="ledger-pagination" aria-label="Pagination">
      <span>Page {pagination.page} of {pagination.totalPages} · {pagination.total} records</span>
      <div>
        {pagination.page > 1 && <Link href={hrefFor(pagination.page - 1)}>Previous</Link>}
        {pagination.page < pagination.totalPages && <Link href={hrefFor(pagination.page + 1)}>Next</Link>}
      </div>
    </nav>
  );
}
