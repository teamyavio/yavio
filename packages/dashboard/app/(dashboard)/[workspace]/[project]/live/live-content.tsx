"use client";

import { EVENT_TYPE_COLORS } from "@/components/analytics/chart-config";
import { EmptyState } from "@/components/analytics/empty-state";
import { EventBadge } from "@/components/analytics/event-badge";
import { PageHeader } from "@/components/analytics/page-header";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatLatency, formatRelativeTime } from "@/lib/analytics/format";
import type { LiveEvent } from "@/lib/queries/types";
import { cn } from "@/lib/utils";
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_EVENTS = 500;

const EVENT_TYPES = [
  "tool_call",
  "conversion",
  "identify",
  "step",
  "page_view",
  "widget_render",
  "widget_click",
  "session_start",
  "session_end",
] as const;

export function LiveContent({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seenIdsRef = useRef(new Set<string>());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const connect = useCallback(() => {
    const params = new URLSearchParams();
    if (eventTypeFilter) params.set("eventType", eventTypeFilter);

    const url = `/api/analytics/${projectId}/live?${params.toString()}`;
    const es = new EventSource(url);

    es.addEventListener("event", (e) => {
      if (pausedRef.current) return;
      try {
        const event = JSON.parse(e.data) as LiveEvent;
        if (seenIdsRef.current.has(event.eventId)) return;
        seenIdsRef.current.add(event.eventId);
        setEvents((prev) => {
          const next = [event, ...prev].slice(0, MAX_EVENTS);
          // Trim the seen set to match retained events
          if (seenIdsRef.current.size > MAX_EVENTS * 2) {
            const retained = new Set(next.map((e) => e.eventId));
            seenIdsRef.current = retained;
          }
          return next;
        });
      } catch {
        // Skip malformed events
      }
    });

    es.addEventListener("heartbeat", () => {
      setConnected(true);
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      reconnectRef.current = setTimeout(connect, 3000);
    };

    es.onopen = () => {
      setConnected(true);
    };

    eventSourceRef.current = es;
  }, [projectId, eventTypeFilter]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connect]);

  return (
    <div className="space-y-6">
      <PageHeader title="Live Feed">
        <div className="flex items-center gap-2">
          <div className={cn("h-2 w-2 rounded-full", connected ? "bg-green-500" : "bg-red-500")} />
          <span className="text-xs text-muted-foreground">
            {connected ? "Connected" : "Reconnecting..."}
          </span>
          <Select
            value={eventTypeFilter || "all"}
            onValueChange={(v) => setEventTypeFilter(v === "all" ? "" : v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="All events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {EVENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setPaused(!paused)} className="gap-1">
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </PageHeader>

      <div aria-live="polite" className="space-y-1">
        {events.length === 0 ? (
          <EmptyState
            title="Waiting for events..."
            description="Events will appear here in real-time as they are ingested."
          />
        ) : (
          events.map((event) => (
            <div key={event.eventId}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md border-l-[3px] px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                style={{
                  borderLeftColor: EVENT_TYPE_COLORS[event.eventType] ?? "#737373",
                }}
                onClick={() => setExpandedId(expandedId === event.eventId ? null : event.eventId)}
              >
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTime(event.timestamp)}
                </span>
                <EventBadge eventType={event.eventType} />
                <span className="flex-1 truncate font-mono text-xs">
                  {event.eventName ?? event.eventType}
                </span>
                {event.latencyMs != null && (
                  <span className="text-xs text-muted-foreground">
                    {formatLatency(event.latencyMs)}
                  </span>
                )}
                {event.status === "error" && <span className="text-xs text-red-600">error</span>}
              </button>
              {expandedId === event.eventId && (
                <div className="ml-4 rounded-md border bg-muted/50 px-4 py-3 text-xs">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">Timestamp</dt>
                    <dd className="font-mono">{event.timestamp}</dd>
                    <dt className="text-muted-foreground">Session</dt>
                    <dd className="font-mono">{event.sessionId}</dd>
                    <dt className="text-muted-foreground">Trace</dt>
                    <dd className="font-mono">{event.traceId}</dd>
                    {event.userId && (
                      <>
                        <dt className="text-muted-foreground">User</dt>
                        <dd className="font-mono">{event.userId}</dd>
                      </>
                    )}
                    {event.platform && (
                      <>
                        <dt className="text-muted-foreground">Platform</dt>
                        <dd>{event.platform}</dd>
                      </>
                    )}
                    {event.errorCategory && (
                      <>
                        <dt className="text-muted-foreground">Error Category</dt>
                        <dd className="text-red-600">{event.errorCategory}</dd>
                      </>
                    )}
                    {event.errorMessage && (
                      <>
                        <dt className="text-muted-foreground">Error Message</dt>
                        <dd className="text-red-600">{event.errorMessage}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
