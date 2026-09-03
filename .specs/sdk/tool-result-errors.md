# Tool-Result Errors Count as Errors

**Status:** Implemented 2026-09-03 (#75; proposed 2026-08-26, reviewed 2026-08-26 with corrections folded in) · **Packages:** sdk, shared, ingest, docs · **Version:** @yavio/sdk 0.4.0 (behavioural change in metrics)

## Problem

A tool that answers the model with `{ isError: true, content: [{ type: "text", text: "This offer reference has expired…" }] }` reports an error — that is exactly what the MCP `CallToolResult.isError` flag is for (tool execution errors are reported *inside* the result, not as protocol errors). The proxy only knows one kind of error: a thrown exception.

`src/server/proxy.ts` (`wrapToolCallback`):

| Path | Today |
|------|-------|
| handler returns (any result) | `status: "success"`, `isError` survives only inside `output_content` |
| handler throws | `status: "error"`, `error_category: "unknown"`, `error_message` from the exception |

Consequences, measured 2026-08-26: *Commerce for Agents* 497 tool_calls, 59 with `output_content.isError = true`, all `status = success`; *Preisvergleich Prod* 14 of 68 (a 21 % error rate shown as 0 %); *Shipal Prod* 4 542 calls with `outputValues: false`, where the flag is not even recorded today. Dashboard error rate **0 %** everywhere, `get_errors` empty. Every dashboard number derived from `status` (`lib/queries/overview.ts`, `tool-detail.ts`, `errors.ts`, MCP `get_errors`) is blind to the errors the model actually sees.

## Decision

A result with `isError === true` is an error. It gets its own category so "the handler told the model something went wrong" (stale reference, invalid postal code, missing field) can be told apart from "the handler crashed".

| Field | Result-level error (`isError === true`) | Thrown (unchanged) |
|-------|------------------------------------------|--------------------|
| status | `error` | `error` |
| error_category | `tool_error` *(new)* | `unknown` |
| error_message | first `content[]` item of type `text`, trimmed, PII-stripped, clamped to 500 chars; absent if no text | exception message, PII-stripped, clamped to 500 chars |
| latency_ms | as today | as today |
| is_retry | unchanged — and note: never set by the SDK today (`proxy.ts` passes no `isRetry`, `capture.retries` is read by nothing), so the column is always 0 despite `metrics/events.md` defining a semantic. Not this spec's job; do not describe it as working. | same |
| input_keys / input_types / input_values / client meta | captured as on the success path (same `captureInput` gate) | as today (`captureInputOnError`) |
| output_content | captured (the model saw it; the text explains the error) | — |
| intent_signals | captured | captured |
| widget token injection | still performed — the result is returned to the client unchanged | — |

Only the literal boolean `true` counts. `"true"`, `1` or a missing flag are not errors (MCP types `isError` as boolean; PostHog's `isToolResultError()` applies the same rule).

`status` is derived from the result object regardless of `capture.outputValues`, so integrators with output capture off (Shipal) get a correct error rate too.

**Interaction with per-tool overrides ([per-tool-capture.md](./per-tool-capture.md)):** for a tool with `outputValues: false`, keep `status` and `error_category` but do **not** store the result-derived `error_message` — that text is output, and a handler echoing "no tariff for customer number …" would leak exactly what the override hides. The thrown-path message stays (developer-written).

`error_message` is stripped through `stripPii()` on **both** paths — today the thrown message is stored raw (`events.ts` `buildToolCallEvent` passes `data.errorMessage` through untouched; it is the one free-text field that bypasses the stripper). A thrown `Error("customer max@example.com not found")` currently lands verbatim. The clamp is a named constant next to `MAX_INTENT_LENGTH` (`MAX_ERROR_MESSAGE_LENGTH = 500`), well below the ingest field limit of 2 048.

`tool_error` vs `unknown` is a server-side distinction only: the MCP SDK also delivers a thrown handler error to the client as an `isError` result (`createToolError()`), so the model sees the same shape in both cases. Docs/tooltip wording: *`tool_error` = the handler returned `isError: true`; `unknown` = the handler threw.*

Not configurable. A flag to keep the old behaviour would only preserve a wrong number.

## Changes

| Package | Change |
|---------|--------|
| shared | `packages/shared/src/events.ts`: `error_category` enum + `"tool_error"`. |
| ingest | No code change; **deploy after the shared bump and before the SDK release** — the validator (`schema-validator.ts`, `IngestEvent.safeParse`) rejects unknown categories per event (`YAVIO-2100`), so an SDK shipped first would lose every tool-error event. |
| sdk | `proxy.ts`: `status`/`error_category`/`error_message` from the result on the success path (helper `toolResultError(result)`); `events.ts`: `errorCategory` union + `"tool_error"`, `error_message` PII-stripped and clamped; README "Captured data" section. |
| dashboard | No query change (all use `status`). `tool-detail.ts` and `errors.ts` render `error_category` raw, so `tool_error` appears without a label map change. Consider a tooltip: *tool_error = the handler returned isError: true*. |
| docs / specs | `.specs/metrics/events.md` tool_call table: `error_category` values + `tool_error`; `error_message` note "also from `isError` results". Docs site: SDK captured-data page. |

## Compatibility

- Error rates rise for every customer on upgrade — this is the correction of an under-count, not a regression. Release note must say so ("error rate now includes tool-reported errors").
- Alerts or thresholds customers built on `status` will fire more. Minor version bump (0.4.0), changelog entry.
- Old SDKs keep sending `success`; nothing on the server side breaks.

## Tests

`src/__tests__/proxy.test.ts`

1. Result `{ isError: true, content: [{type:"text", text:"boom"}] }` → `status: error`, `error_category: tool_error`, `error_message: "boom"`, inputs and output captured, widget token still injected (non-serverOnly).
2. Result with `isError: true` and no text content → error without `error_message`.
3. `isError: false`, `isError: "true"`, no flag → `success`.
4. Message clamp at 500 chars; `max@example.com` in the text → `[EMAIL_REDACTED]` (both paths).
5. Thrown error message with an email → stripped (regression for the raw pass-through).

`packages/shared` schema test: `tool_error` accepted. Ingest integration: a batch with `error_category: tool_error` is accepted (207 without rejections).

## Known blind spot (not closed by this spec)

`McpServer` runs `validateToolInput()` **before** `executeToolHandler()` and turns every failure — argument validation, disabled tool, unknown tool — into an `isError` result via `createToolError()` (`mcp.js` ~125–142 in SDK 1.30). The proxy wraps the *callback*, which never runs in those cases, so **no `tool_call` event exists at all** for them, before or after this change. PostHog counts them because it wraps the low-level `tools/call` handler; Yavio has such a wrapper (`intent.ts` `wrapCallHandler`) but installs it only when intent capture is on. Follow-up: **#77** — move status detection to the protocol layer so pre-handler failures are counted.

## Compatibility note on pins

Every consumer pins `^0.3.0` / `^0.2.0`; on 0.x the 0.4.0 error-rate change is therefore opt-in per app — no dashboard jumps without an explicit bump. Say so in the release notes.

## Open Questions

- Should `tool_error` results count toward `is_retry` differently? Moot until `is_retry` is implemented at all (see table).
- Category refinement (mapping validation text to `validation`) belongs to #77, where the pre-handler failures become visible.
