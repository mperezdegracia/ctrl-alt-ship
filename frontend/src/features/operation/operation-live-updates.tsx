"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { formatDateTime } from "@/lib/dashboard-api";
import { createClient } from "@/lib/supabase/client";

type ConnectionState = "connecting" | "live" | "reconnecting" | "unavailable";

type StreamMessage = { type: string; data: Record<string, unknown> };

function apiBaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? null;
}

function readMessages(value: string): { rest: string; messages: StreamMessage[] } {
  const frames = value.split("\n\n");
  const rest = frames.pop() ?? "";
  const messages = frames.flatMap((frame) => {
    if (!frame || frame.startsWith(":")) return [];
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
    const rawData = frame.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    if (!event || !rawData) return [];
    try {
      const data = JSON.parse(rawData) as Record<string, unknown>;
      return [{ type: event, data }];
    } catch {
      return [];
    }
  });
  return { rest, messages };
}

type LiveUpdatesProps = {
  endpoint: string;
  scope: "operation" | "register";
  updatedAt?: string;
};

function LiveUpdates({ endpoint, scope, updatedAt }: LiveUpdatesProps) {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionState>(() => apiBaseUrl() ? "connecting" : "unavailable");
  const [isRefreshing, startTransition] = useTransition();
  const retryDelay = useRef(1_500);

  useEffect(() => {
    const baseUrl = apiBaseUrl();
    if (!baseUrl) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const reconnect = () => {
      if (disposed) return;
      setConnection("reconnecting");
      const delay = retryDelay.current;
      retryDelay.current = Math.min(retryDelay.current * 2, 15_000);
      retryTimer = setTimeout(() => { void connect(); }, delay);
    };

    const connect = async (): Promise<void> => {
      controller = new AbortController();
      try {
        const { data: sessionData } = await createClient().auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          setConnection("unavailable");
          return;
        }

        const response = await fetch(
          `${baseUrl}${endpoint}`,
          {
            headers: { Accept: "text/event-stream", Authorization: `Bearer ${accessToken}` },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) throw new Error(`Live stream unavailable (${response.status})`);

        retryDelay.current = 1_500;
        setConnection("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = readMessages(buffer);
          buffer = parsed.rest;
          for (const message of parsed.messages) {
            if (message.type.endsWith(".changed")) {
              setConnection("live");
              startTransition(() => { router.refresh(); });
            }
            if (message.type === "operation.removed") {
              startTransition(() => { router.refresh(); });
            }
            if (message.type === "stream.error") setConnection("reconnecting");
          }
        }
        if (!disposed) reconnect();
      } catch {
        if (!disposed && !controller?.signal.aborted) reconnect();
      }
    };

    void connect();
    return () => {
      disposed = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [endpoint, router, startTransition]);

  const subject = scope === "operation" ? "record" : "register";
  const label = isRefreshing ? `Refreshing verified ${subject}` : connection === "live"
    ? `Live ${subject}` : connection === "unavailable" ? "Live stream unavailable" : `Reconnecting to live ${subject}`;
  const copy = isRefreshing ? `A persisted operation event arrived; reading the updated ${subject}.`
    : connection === "live" ? scope === "operation"
      ? "Watching verified calls and operational decisions as they are persisted."
      : "Watching the durable operations register for newly persisted work."
      : connection === "unavailable" ? `The ${subject} remains available; live updates will resume when the operations API is reachable.`
        : `The ${subject} remains available while the connection to the operations API is restored.`;

  return (
    <section className={`operation-live-strip is-${connection} is-${scope}`} aria-label={`Live ${subject} update status`} aria-live="polite">
      <div>
        <span className="operation-live-label"><i aria-hidden="true" />{label}</span>
        <p>{copy}</p>
      </div>
      {updatedAt ? <time dateTime={updatedAt}>Verified {formatDateTime(updatedAt)}</time> : <time>Awaiting first verified record</time>}
    </section>
  );
}

export function OperationLiveUpdates({ reference, updatedAt }: { reference: string; updatedAt: string }) {
  return <LiveUpdates endpoint={`/api/dashboard/operations/${encodeURIComponent(reference)}/stream`} scope="operation" updatedAt={updatedAt} />;
}

export function DashboardLiveUpdates({ updatedAt }: { updatedAt?: string }) {
  return <LiveUpdates endpoint="/api/dashboard/stream" scope="register" updatedAt={updatedAt} />;
}
