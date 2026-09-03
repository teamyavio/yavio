# Per-Tool Capture Overrides

**Status:** Implemented 2026-09-03 (#74; proposed 2026-08-26, reviewed 2026-08-26 with corrections folded in) · **Packages:** sdk, shared (error catalog text), docs · **Version:** @yavio/sdk 0.4.0 (additive)

## Problem

Some tools take data that must never reach analytics — a booking tool with an IBAN, a support tool with a message body. Today a developer has two options, both bad:

| Option | Effect |
|--------|--------|
| `capture.inputValues: false` (global) | Loses input capture for *every* tool, including the ones the dashboard is for. |
| Register the tool on the unwrapped server | No `tool_call` event (latency, status, intent lost) **and** `yavio.conversion()` / `track()` / `step()` / `identify()` become silent no-ops: `createYavioContext()` is built without a fallback store and only emits inside a wrapped callback's `AsyncLocalStorage` context. Verified 2026-08-26 with a capture endpoint: two bookings, zero conversion events, no warning. |

`stripPii()` is not a substitute: it matches emails, Luhn-valid card numbers, US SSNs and US phone formats — not IBANs, names, addresses or birth dates.

Commerce for Agents runs the second option today, so its funnel ends at "compared" and the `booking_received` conversion never arrives (live 2026-08-26: 46 `switch_link_issued` conversions from the proxied tool, 0 `booking_received`; the switch-link tool has since been removed, which makes the booking the only conversion left).

## Decision

`withYavio()` accepts per-tool overrides of the capture flags, merged over the global `capture` config. The tool stays on the proxy, so context, session, trace, latency, status and conversions work; the SDK — not the registration site — guarantees what is not captured.

```ts
withYavio(server, {
  capture: { inputValues: true, outputValues: true },
  tools: {
    "book-contract": { inputValues: false, outputValues: false, intent: false },
  },
});
```

```ts
interface ToolCaptureOverride {
  inputValues?: boolean;   // false: no input_keys, input_types, input_values, client meta for this tool
  outputValues?: boolean;  // false: no output_content for this tool
  intent?: boolean;        // false: no `context` parameter advertised or captured for this tool
}
interface WithYavioOptions { …; tools?: Record<string, ToolCaptureOverride> }
```

| Aspect | Decision |
|--------|----------|
| Resolution | `resolveToolCapture(name) = { ...config.capture, ...config.tools?.[name] }`, computed in both interceptors (`tool()` and `registerTool()`, MCP SDK and Skybridge calling conventions) and passed into `wrapToolCallback` as `capture` (replaces the `config.capture` reads inside). |
| `inputValues: false` semantics | Identical to the global flag on that call: no `input_keys`, `input_types`, `input_values`, and no client meta (`locale`, `country_code`, `end_user_agent`, `subject_id`), on both the success and the throw path. One code path, no new semantics. |
| `outputValues: false` | No `output_content`, and — once [tool-result-errors.md](./tool-result-errors.md) ships — no result-derived `error_message` either (that text is output). `status`/`error_category` stay. `error_message` on a throw is still captured — it is developer-written; the README says so. |
| `intent: false` | A **third state** in the intent controller (today `isEligible()` means strip *and* capture): never advertise `context` for the tool, never capture it, **still strip** it if a client sends one — a client with a cached schema keeps sending it, and a strict Zod schema would otherwise reject the call. Motivation: a model's intent sentence for a booking tool tends to contain the user's name. Scope: on/off per tool; per-tool *required/optional* (#73 item 2) stays open. |
| Still emitted | `tool_discovery` (description + schema, no user data), `tool_call` with latency/status/intent (unless disabled), conversions/track/step/identify from inside the handler with full session context. |
| Config sources | `withYavio()` options and `.yaviorc.json` (`"tools": {…}`). No env-var form (nested). |
| Unknown tool names | Not validated — tools register after `withYavio()`. Documented. |
| Widget token injection | Unaffected. |

### Warn on tracking calls outside a wrapped call

The silent no-op is the reason this went unnoticed. `conversion()`, `track()`, `step()`, `identify()` called with no active store log **once per process**:

`[YAVIO-1105] yavio.<method>() called outside a wrapped tool call — event dropped. Register the tool through withYavio() (use `tools` overrides to limit capture).`

Reuse the existing, so far unused `SDK.CONTEXT_INJECTION_UNAVAILABLE = "YAVIO-1105"` (`packages/shared/src/error-codes.ts:29`) — no new code. Its catalog entry (`.specs/07_error-catalog.md`) is wrong and must be corrected: it says such calls "will lack traceId and sessionId"; in reality the event is **dropped**. The docs page `02-sdk/02-tracking-api.mdx` currently documents the silence as intended ("calls outside that context are silently ignored") and changes with this spec, not only the README.

## Changes

| Package | Change |
|---------|--------|
| sdk | `core/types.ts` (`ToolCaptureOverride`, `WithYavioOptions.tools`, `YavioConfig.tools`), `core/config.ts` (merge from options + `.yaviorc.json`), `server/proxy.ts` (resolve + pass per-tool capture; both interceptors), `server/intent.ts` (`disabledTools`), `server/context.ts` (warn-once), README options block + "Per-tool overrides" section. |
| shared | catalog text of `YAVIO-1105` corrected (event dropped, warn-once). |
| specs / docs | `.specs/sdk/server-sdk.md` config table; `07_error-catalog.md` (1105 text); docs site SDK configuration page, `02-sdk/02-tracking-api.mdx` (no longer "silently ignored"), privacy guidance ("for tools with sensitive input use `tools` overrides, not unwrapped registration"). |

### Migration: Commerce for Agents

Register `book-contract` through the proxy with `tools: { "book-contract": { inputValues: false, outputValues: false, intent: false } }`, delete the "registered on the unwrapped server" invariant from `server.ts` and README, keep the explicit `yavio.conversion("booking_received")`. Verification: `scripts/analytics-funnel.mjs --book` against the capture harness → conversion present with the session's ids, PII grep 0 hits (IBAN, name, birth date, street, customer/meter number, email, phone).

## Compatibility

Additive; no behaviour change without `tools`. Minor bump. The warn-once is new output on stderr for integrators who call the singleton outside context — intended.

## Tests

- `config.test.ts`: merge precedence (global → per-tool), `.yaviorc.json` `tools`, unknown keys ignored.
- `proxy.test.ts`: override applied via `server.tool()`, `server.registerTool(name, cfg, cb)` and Skybridge `registerTool(cfg, cb)`; `inputValues:false` → none of the four input/meta fields on success and on throw; `outputValues:false` → no `output_content`; other tools unaffected in the same server.
- `integration/intent.test.ts`: `intent:false` tool is listed without `context`; **strict Zod schema + per-tool `intent: false` + client sends `context` → handler receives no `context`, the call succeeds, nothing captured**; other tools still advertise it.
- `context.test.ts`: conversion from an overridden tool carries the call's `session_id`/`trace_id`; outside context → dropped + single `YAVIO-1105` warning for repeated calls.

## Open Questions

- Client meta (`subject_id`, `locale`, `country_code`, `end_user_agent`) stays coupled to `inputValues` **on purpose, not for tidiness**: decoupling would silently *start* collecting these fields for every existing integrator who set `inputValues: false` as their privacy posture (R+V, Shipal) — a collection expansion with app-store sensitivity (the session-id decline), which needs its own opt-in decision. It costs Commerce for Agents nothing: conversion events never carry `subject_id` (base fields have only `user_id`), and the session's other calls still carry it. Anyone touching this later should treat it as a policy change, not a refactor.
- Per-tool `capture.tokens` / `retries` — no use case, not included.
