"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { CustomEventEntry } from "@/lib/queries/types";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode } from "react";

/**
 * One expanded-event layout for the live feed, the invocation list and the
 * tool detail page (#48): labelled metadata fields, monospace collapsible
 * payloads and a way to copy the raw event. Every value shown here is
 * integrator- or model-supplied content and is rendered as plain text only.
 */

export interface DetailField {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: "default" | "error";
}

export function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function hasContent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "" && value !== "{}";
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h4>
  );
}

/** Labelled metadata in a definition list; two label/value pairs per row on wide screens. */
export function DetailFields({ fields }: { fields: DetailField[] }) {
  const shown = fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
      {shown.map((field) => (
        <Fragment key={field.label}>
          <dt className="whitespace-nowrap text-muted-foreground">{field.label}</dt>
          <dd
            className={cn(
              "min-w-0 break-words",
              field.mono && "font-mono",
              field.tone === "error" && "text-red-600",
            )}
          >
            {field.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A JSON (or free-text) payload, pretty-printed in a collapsible monospace block. */
export function JsonPayload({
  label,
  raw,
  defaultOpen = true,
}: {
  label: string;
  raw: string;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto rounded border bg-background p-3 font-mono text-xs">
        {tryFormatJson(raw)}
      </pre>
    </details>
  );
}

/**
 * Key-value view of an event's metadata JSON. Falls back to the raw payload
 * when the metadata is not a JSON object.
 */
export function MetadataGrid({ raw }: { raw: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return (
      <pre className="max-h-60 overflow-auto rounded border bg-background p-3 font-mono text-xs">
        {tryFormatJson(raw)}
      </pre>
    );
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {Object.entries(parsed as Record<string, unknown>).map(([key, value]) => (
        <Fragment key={key}>
          <dt className="whitespace-nowrap font-mono text-xs leading-6 text-muted-foreground">
            {key}
          </dt>
          <dd className="min-w-0 break-words">{formatMetadataValue(value)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Copies the event as pretty-printed JSON. */
export function CopyRawButton({
  value,
  label = "Copy raw event",
}: { value: unknown; label?: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => copy(JSON.stringify(value, null, 2))}
      className="gap-1"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

interface EventDetailProps {
  /** Labelled metadata shown first. */
  fields: DetailField[];
  /** The event as received; offered for copying. */
  raw: unknown;
  /** Payload sections (JsonPayload, MetadataGrid, ...) shown below the fields. */
  children?: ReactNode;
}

export function EventDetail({ fields, raw, children }: EventDetailProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <DetailFields fields={fields} />
        <CopyRawButton value={raw} />
      </div>
      {children}
    </div>
  );
}

export interface InvocationPayloads {
  intent?: string | null;
  intentSource?: string | null;
  inputValues: string | null;
  outputContent: string | null;
  metadata: string | null;
  customEvents?: CustomEventEntry[];
}

/**
 * The payload sections of one tool invocation: intent, arguments, result,
 * properties and the custom events of its trace. Shared by the invocation
 * list (#44) and the tool detail page.
 */
export function InvocationPayloadSections({ invocation }: { invocation: InvocationPayloads }) {
  const intent = hasContent(invocation.intent) ? invocation.intent : null;
  const input = hasContent(invocation.inputValues) ? invocation.inputValues : null;
  const output = hasContent(invocation.outputContent) ? invocation.outputContent : null;
  const properties = hasContent(invocation.metadata) ? invocation.metadata : null;
  const customEvents = invocation.customEvents ?? [];

  if (!intent && !input && !output && !properties && customEvents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No input/output data captured for this invocation.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {intent && (
        <div>
          <SectionTitle>Intent</SectionTitle>
          <p className="flex items-start gap-2 text-sm">
            <span className="min-w-0 break-words">{intent}</span>
            {invocation.intentSource === "inferred" && (
              <Badge variant="outline" className="shrink-0 text-xs">
                inferred
              </Badge>
            )}
          </p>
        </div>
      )}
      {input || output ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            {input ? (
              <JsonPayload label="Input" raw={input} />
            ) : (
              <>
                <SectionTitle>Input</SectionTitle>
                <p className="text-sm text-muted-foreground">No input captured</p>
              </>
            )}
          </div>
          <div>
            {output ? (
              <JsonPayload label="Output" raw={output} />
            ) : (
              <>
                <SectionTitle>Output</SectionTitle>
                <p className="text-sm text-muted-foreground">No output captured</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No input/output data captured for this invocation.
        </p>
      )}
      {properties && (
        <div>
          <SectionTitle>Properties</SectionTitle>
          <MetadataGrid raw={properties} />
        </div>
      )}
      {customEvents.length > 0 && (
        <div>
          <SectionTitle>Custom Events</SectionTitle>
          <div className="space-y-3">
            {customEvents.map((ev, i) => (
              <div key={`${ev.eventName}-${i}`} className="rounded border p-3">
                <Badge variant="outline" className="mb-2 text-xs">
                  {ev.eventName}
                </Badge>
                <MetadataGrid raw={ev.metadata} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
