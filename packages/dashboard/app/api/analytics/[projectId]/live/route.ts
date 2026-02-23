import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import { queryRecentEvents } from "@/lib/queries/live";
import { ErrorCode } from "@yavio/shared/error-codes";
import { NextResponse } from "next/server";

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_CONNECTIONS_PER_USER = 5;

const connectionCounts = new Map<string, number>();

export const GET = withAnalyticsAuth("viewer")(async (request, ctx) => {
  const userId = ctx.userId;

  const currentCount = connectionCounts.get(userId) ?? 0;
  if (currentCount >= MAX_CONNECTIONS_PER_USER) {
    return NextResponse.json(
      { error: "Too many live feed connections", code: ErrorCode.DASHBOARD.SSE_CONNECTION_LIMIT },
      { status: 429 },
    );
  }

  const url = new URL(request.url);
  const eventType = url.searchParams.get("eventType") ?? undefined;

  connectionCounts.set(userId, currentCount + 1);

  let lastTimestamp = new Date(Date.now() - 10_000).toISOString();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const timers: {
        poll?: ReturnType<typeof setInterval>;
        heartbeat?: ReturnType<typeof setInterval>;
      } = {};

      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          cleanup();
        }
      };

      const poll = async () => {
        if (closed) return;
        try {
          const events = await queryRecentEvents(
            { workspaceId: ctx.workspaceId, projectId: ctx.projectId },
            lastTimestamp,
            eventType,
          );

          for (const event of events.reverse()) {
            send("event", JSON.stringify(event));
            if (event.timestamp > lastTimestamp) {
              lastTimestamp = event.timestamp;
            }
          }
        } catch {
          // Silently skip poll errors
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timers.poll);
        clearInterval(timers.heartbeat);
        const count = connectionCounts.get(userId) ?? 1;
        if (count <= 1) {
          connectionCounts.delete(userId);
        } else {
          connectionCounts.set(userId, count - 1);
        }
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      // Initial poll
      poll();

      timers.poll = setInterval(poll, POLL_INTERVAL_MS);
      timers.heartbeat = setInterval(() => {
        send("heartbeat", JSON.stringify({ time: new Date().toISOString() }));
      }, HEARTBEAT_INTERVAL_MS);

      // Handle client disconnect
      if (request.signal) {
        request.signal.addEventListener("abort", cleanup);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
