"use client";

import { useSyncExternalStore } from "react";

import { formatDateTime, formatWindow } from "@/lib/dashboard-api";
import type { DashboardWindow } from "@/lib/dashboard-api";

function subscribeToTimeZone(): () => void {
  return () => undefined;
}

function readViewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function useViewerTimeZone(): string {
  return useSyncExternalStore(subscribeToTimeZone, readViewerTimeZone, () => "UTC");
}

type LocalDateTimeProps = {
  value: string;
  className?: string;
};

export function LocalDateTime({ value, className }: LocalDateTimeProps) {
  const timeZone = useViewerTimeZone();
  return <time className={className} dateTime={value} suppressHydrationWarning>{formatDateTime(value, timeZone)}</time>;
}

type LocalTimeRangeProps = {
  window: DashboardWindow | null;
  className?: string;
};

export function LocalTimeRange({ window, className }: LocalTimeRangeProps) {
  const timeZone = useViewerTimeZone();
  if (!window) return <span className={className}>Not recorded</span>;
  return <time className={className} dateTime={window.startAt} suppressHydrationWarning>{formatWindow(window, timeZone)}</time>;
}

export function LocalTimeRanges({ windows, className }: { windows: DashboardWindow[]; className?: string }) {
  const timeZone = useViewerTimeZone();
  if (windows.length === 0) return <span className={className}>Not recorded</span>;

  return (
    <ol className={["time-range-list", className].filter(Boolean).join(" ")}>
      {windows.map((window) => (
        <li key={`${window.startAt}-${window.endAt}`}>
          <time dateTime={window.startAt} suppressHydrationWarning>{formatWindow(window, timeZone)}</time>
        </li>
      ))}
    </ol>
  );
}
