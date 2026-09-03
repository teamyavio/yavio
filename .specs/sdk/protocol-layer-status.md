# Status Detection at the Protocol Layer

**Status:** Proposed 2026-09-03 (#77), implemented in the same PR · **Packages:** sdk, docs · **Version:** @yavio/sdk 0.4.0 if merged before the tag, otherwise 0.5.0 (behavioural change in metrics) · **Depends on:** [tool-result-errors.md](./tool-result-errors.md) (#75), [per-tool-capture.md](./per-tool-capture.md) (#74)

## Problem

`McpServer`'s `tools/call` handler does work **before** the tool callback runs and converts every failure into an `isError` result via `createToolError()` (`@modelcontextprotocol/sdk` `server/mcp.js`, 1.26–1.30):

| Failure | Where | What the model sees |
|---------|-------|---------------------|
| unknown tool name | before the callback | `isError` result "Tool X not found" |
| disabled tool (`RegisteredTool.disable()`) | before | "Tool X disabled" |
| argument validation (`validateToolInput()`, Zod) | before | "Input validation error: Invalid arguments for tool X: …" |
| task-support misconfiguration | before | "Tool X has taskSupport … but was not registered with registerToolTask" |
| output validation (`validateToolOutput()`, declared `outputSchema`, mismatching `structuredContent`) | **after** the callback returned | "Output validation error: …" |

The Yavio proxy wraps the tool **callback**. For the first four the callback never runs, so no `tool_call` event exists at all — before or after #75. For the last, the callback ran and its event says `success` although the model received an error. PostHog counts all of these because it wraps the low-level `tools/call` request handler. Yavio has such a wrapper (`intent.ts` `wrapCallHandler`) but only installs it when intent capture is on, and only for intent.

The cases are not exotic. Argument validation is the failure mode of every model that guesses a parameter type, and the dashboard currently cannot show it.

## Decision

Install a `tools/call` wrapper on the low-level server **always** (not only with intent capture), and let it own **when** a `tool_call` event is emitted. The callback wrapper keeps owning **what** is captured for a call that reached the handler.

### Mechanics: one call, one frame, one event

```
tools/call request
  └─ intent wrapper (only when intent is on)   strips/captures `context`
       └─ status wrapper (always)              opens a CallFrame in AsyncLocalStorage
            └─ McpServer handler                validate → callback → validate output → createToolError
                 └─ callback wrapper            builds the tool_call event, hands it to the frame
```

- The **status wrapper** opens a `CallFrame` `{ toolName, context, event: null, startedAt }` for the request, resolves the session/trace/platform context once (`openCallContext(extra)` — the code that used to live inline in `wrapToolCallback`), and runs the downstream handler inside the frame.
- The **callback wrapper**, when it finds a frame, reuses the frame's context (same `trace_id`, same session) and stores the event it built on the frame **instead of sending it**. Without a frame — the handler invoked directly, the private API unavailable — it sends immediately, exactly as today.
- After the downstream handler returns or throws, the status wrapper sends **exactly one** event:

| Outcome | Frame has a callback event | Emitted event |
|---------|----------------------------|---------------|
| callback ran, result matches its event | yes | the callback's event, unchanged |
| callback ran, its event says `success`, final result has `isError: true` | yes | the callback's event with `status: error`, `error_category: server`, `error_message` from the result — output validation failed after the handler |
| callback never ran, final result has `isError: true`, tool is instrumented or unregistered | no | a new event: `status: error`, `error_category: validation` (see below) |
| callback never ran, result is not an error | no | nothing — the tool is not instrumented at the callback level (registered on the unwrapped server, or a task-based tool), and that must stay untracked |
| callback never ran, downstream threw | no | nothing — a JSON-RPC error the proxy has no business classifying (today: only `UrlElicitationRequired`) |

"Instrumented" = the proxy wrapped the tool's callback (`instrumentedTools`, fed by both interceptors). "Unregistered" = the name is absent from the live registry (`_registeredTools`, the same private read `intent.ts` already does; when unreadable, treat as registered).

Two events for one call are impossible by construction: the callback wrapper sends only without a frame, the status wrapper sends only from within one.

### Fields of a pre-handler failure event

| Field | Value |
|-------|-------|
| `event_name` | `request.params.name` — for an unknown tool, the name the model asked for. The dashboard then lists it as a tool with a 100 % error rate, which is the honest signal ("the model keeps calling `search_flights`, which does not exist") |
| `status` / `error_category` | `error` / `validation` — for unknown, disabled, argument validation and task misconfiguration alike. All four are `InvalidParams`-class failures of the request itself; the MCP SDK hands them over as one text, so a finer split would mean parsing message prefixes. `error_message` carries the reason |
| `error_message` | the `isError` result's text (`createToolError`), PII-stripped, clamped — **gated on the resolved `outputValues`** like every result-derived message (#75 rule): Zod 3 enum errors echo the received value, so the text can contain input |
| `latency_ms` | **absent**. The handler never ran; there is no execution time to report, and a wall-clock value of ~0 ms would only drag the tool's latency percentiles down |
| `input_keys` / `input_types` / `input_values` / client meta | from the **raw** `request.params.arguments` and `extra`, under the tool's resolved capture flags (`resolveToolCapture(name)`; global flags for an unregistered name). For an argument-validation failure the raw arguments are exactly what is interesting: what did the model send? |
| `output_content` | the error result, under `outputValues` |
| `intent_signals` | whatever the intent wrapper captured — it sits outside the status wrapper, so `getCapturedIntent()` works and the captured arguments are already free of `context` |
| session / trace / platform | as for any call (`openCallContext`), including the deferred connection event on the first call of a session |

### The post-handler case

`validateToolOutput()` failing is a server bug (the tool declares an `outputSchema` its own `structuredContent` does not satisfy). The callback's event keeps its latency and captured data; only `status`, `error_category: server` and the (output-gated) `error_message` change. Rare, but until now it was recorded as a success on every single call.

### Composition with the intent wrapper

Both wrap the same handler, so the order must be fixed in one place. `server/protocol.ts` owns the patching that `intent.ts` `install()` used to do — locating the low-level server, seeding, patching `setRequestHandler`, wrapping already-registered handlers, idempotency — and applies a list of wrappers **innermost first**: `[status, intent]` yields `intent(status(mcpHandler))`. The intent controller no longer installs itself; it exposes its call and list wrappers and the proxy composes them.

Status must be the inner wrapper: it then runs inside the intent store (so a pre-handler failure still carries `intent_signals`) and sees arguments with `context` already removed.

### When the private API is missing

`installProtocolWrappers()` returns `false` when the server exposes no `server.setRequestHandler` (Skybridge-style facades in the test-suite, an MCP SDK that moved the field). Nothing else changes: no frame is ever opened, the callback wrapper sends immediately, and pre-handler failures stay invisible — today's behaviour, never worse. Intent capture already degrades the same way.

## Changes

| Package | Change |
|---------|--------|
| sdk | `server/protocol.ts` (new: `installProtocolWrappers`, `CallFrame` store), `server/proxy.ts` (`openCallContext`, `instrumentedTools`, status wrapper, callback wrapper hands events to the frame), `server/intent.ts` (no self-install; exposes `wrapCall`/`wrapList` + `attach(server)` for the registry seeding), README "Status and errors" (validation row, latency note), docs events page. |
| shared / ingest / db | None — `validation` and `server` already exist in the enum. |
| dashboard | None — queries use `status`; `validation` renders with the existing tooltip. |

## Compatibility

- Error rates rise again on upgrade (argument-validation failures were never counted). Release note.
- `latency_ms` becomes nullable for error rows in practice; every dashboard aggregate (`avg`, `quantile`) already skips NULL.
- Unknown tool names appear as tools in the dashboard. Deliberate — see the table.
- Behaviour with the private API missing is unchanged.

## Tests (`integration/protocol.test.ts`, InMemoryTransport end to end)

1. Argument validation failure → exactly one `tool_call`: `status: error`, `validation`, message contains "Input validation error", **no** `latency_ms`, raw arguments in `input_values`, client meta present, client received `isError: true`.
2. Unknown tool → one event named after the request, `validation`.
3. Disabled tool → one event, `validation`.
4. Success → exactly one event, with latency; a conversion from inside the handler shares its `trace_id`.
5. Handler throws → exactly one event, `unknown`. Handler returns `isError` → exactly one event, `tool_error`.
6. Output validation failure → exactly one event, `status: error`, `server`, latency present.
7. Intent on + validation failure with `context` sent → event has `intent_signals`, `input_values` has no `context`.
8. Per-tool `inputValues: false` → the validation event carries no inputs or client meta; `outputValues: false` → no `error_message`, status/category kept.
9. Tool registered on the **unwrapped** server → validation failure and success both produce **no** event.
10. Direct handler invocation without a frame → event sent immediately (the existing `proxy.test.ts` suite).
11. Server without the private API → callback path still emits (the existing Skybridge tests).
12. All existing intent tests pass unchanged after the install refactor.

## Open Questions

- Task-based tools (`registerToolTask`) are not intercepted by the proxy at all today; their pre-handler failures are therefore not counted either (rule: no callback event + not instrumented → nothing). Separate issue if task tools ever ship in a Yavio-instrumented app.
- A `context` sent from a cached schema **after intent capture was turned off** reaches the raw arguments of a validation-failure event (there is no intent wrapper to strip it). Edge of an edge; the text is PII-stripped like everything else. Noted, not handled.
