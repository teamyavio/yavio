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
| callback never ran, result is not an error | no | nothing — the tool is not instrumented at the callback level (registered on the unwrapped server under `withYavio()`, or a task-based tool), and that must stay untracked |
| tool is **registered but not instrumented** (unwrapped server under `withYavio()`, task tool) | — | no frame at all: the wrapper calls straight through, so not even the session's connection event or platform detection runs for it *(code review 2026-10-13)* |
| callback never ran, downstream threw | no | nothing — a JSON-RPC error the proxy has no business classifying (today: only `UrlElicitationRequired`) |
| *(#168, 0.5.5)* the request's result is a 2026-07-28 interim result (`resultType: "input_required"` on a v2 context) | no — the round kept its event on the frame as `interim` | nothing — the client retries as a new request with its own frame, and that request's final round sends the call's event, marked `metadata.input_retry` |
| *(#168)* the callback ran several times in the frame: v2's 2025-era legacy shim fulfilled `input_required` results and re-entered the handler | yes — the final round's; the interim rounds handed nothing over | that event: the frame's trace, the final round's output and status, the post-handler checks as above, `latency_ms` summed over the rounds, `metadata.input_rounds` |
| *(#168)* the callback returned `input_required`, then the request failed before a final round — the shim's `isError` result (no channel to the client, a capability the client did not declare, a failed or timed-out leg, too many rounds) or a throw (v2 refusing a 2026-07-28 input request, an aborted shim request) | no — `interim` only | the latest interim round's event, corrected to `status: error`, `error_category: server` with the result's or the throw's message (output-gated), its handler time and `input_rounds`. Exception: a `UrlElicitationRequired` thrown by a later shim round sends nothing (the client retries the call after the URL flow, as a new call) |
| *(#168, review round 1)* a 2026-07-28 retry (`frame.inputRetry`) that v2 refuses **before** the handler with `-32602` `"Invalid or expired requestState"`, `data.reason: "invalid_request_state"` (the integrator's `requestState.verify` hook threw, or a non-string state) | no | a new event built like a pre-handler failure, but `error_category: server`: the call's handler ran in an earlier request and asked for input, and the round trip failed — the same category the shim gives the same refusal after an interim round (row above). No `latency_ms`, the retry's arguments stored like a rejected call's (nothing validated them in this request), v2's frozen text as `error_message`, `metadata.input_retry`. Not `validation`: that category means the model's request was malformed (unknown or disabled tool, arguments the schema rejected), it has no latency by definition, and on the shim the handler did run |
| *(#168, review rounds 1 and 2)* a 2026-07-28 retry the MCP SDK rejects before the handler for any other reason: the tool disabled, removed or with a changed schema between the rounds (a fleet mid-deploy) | no | the pre-handler-failure event, but `error_category: server` and `metadata.input_retry`, for the reason given in the row above: the shim gives the same failures after an interim round in one request (McpServer's re-entry finds the tool disabled or the arguments rejected) and counts them `server` (the interim event, corrected), so both eras agree. A tool-not-found or schema rejection of a request that is **not** a retry stays `validation`. `finalizeCallEvent` decides it from `frame.inputRetry` |

"Instrumented" = the proxy wrapped the tool's callback (`instrumentedTools`, fed by both interceptors). "Unregistered" = the name is absent from the live registry (`_registeredTools`, the same private read `intent.ts` already does; when unreadable, treat as registered).

One event per frame holds by construction: the callback wrapper sends only without a frame, the status wrapper sends only from within one. The original wording, "two events for one call are impossible by construction", did not hold once MCP SDK v2's 2025-era legacy shim existed: it re-enters the handler inside one frame for every `input_required` result it fulfils, and up to 0.5.4 every round after the first found the frame taken and sent its event directly — N rounds of input gave N+1 events, the final round's first, and the final round's post-handler verdict was stamped on round 1's event. Since 0.5.5 a round that asks for input hands nothing over (see "Multi-round-trip calls" below), so the frame sends exactly one event again. On 2026-07-28 every round is its own request and frame, and only the request whose result is final sends.

### Multi-round-trip calls (#168, 0.5.5)

MCP 2026-07-28 replaces server-to-client requests with multi-round-trip requests (MRTR): a handler that needs input returns an `InputRequiredResult` (`resultType: "input_required"`, `inputRequests` and/or `requestState`), and the client retries the original request as a new request with `inputResponses` and the echoed `requestState`. v2 (`@modelcontextprotocol/server`, from 2.0.0) lifts those into `ctx.mcpReq.inputResponses`, `droppedInputResponseKeys` and the `requestState()` accessor. For 2025-era requests v2's legacy shim (`ServerOptions.inputRequired.legacyShim`, on by default) sits inside the handler v2 stored — between the status wrapper and McpServer's handler — sends the embedded requests to the client and calls McpServer's handler again with a context it filled itself.

- **Detection:** a plain object with `resultType === "input_required"` (v2's `isInputRequiredResult`, the same expression from 2.0.0 to 2.4.0; not imported) returned on a context with `ctx.mcpReq`. v1 has no MRTR, so a v1 tool returning that shape is an ordinary call.
- **An interim round** sends no event, mints nothing usable (the mint started before the handler is dropped unused: one wasted `POST /v1/widget-tokens` without `serverOnly`) and returns the handler's result object untouched — no `_meta.yavio` in any mode; the v2 client consumes it internally. The frame keeps `inputRounds`, `inputMs` (the unrounded handler time) and the round's would-be event (`interim`). Round 1's token is not reused for later shim rounds: a token lives 15 minutes, a shim leg may wait 600 s and there can be 8 of them.
- **Markers in `metadata`:** `input_rounds` (rounds inside this request that returned `input_required` before the result that went out) and `input_retry: true` (the context the protocol layer received carries `inputResponses`, `droppedInputResponseKeys` or a `requestState()` value — read there because the shim's re-entry context carries the same fields). `is_retry` is not used: it means "the preceding event in the session was the same tool" and has never been set.
- **`latency_ms`** is the handler time summed over the rounds the request contained; the client's think time is never in it. On the shim that is every round, on 2026-07-28 the final request only.
- **No SDK state across 2026-07-28 rounds.** A token inside `requestState` would change a result `serverOnly` promises stays byte-identical, would be attacker-controlled data (the spec says so of `requestState`) or need a signing key, and would have to be stripped from the context v2 hands the handler; a per-process map keyed by session and tool fails on a fleet, for `per_request` sessions and for concurrent calls. So the earlier rounds of a 2026-07-28 call are in no event, a call whose client never retries leaves no `tool_call`, and a `track()` inside an interim round carries a trace no `tool_call` has.
- **Without a frame** (handler called directly, protocol layer unavailable) an interim round still sends nothing and returns its result untouched, and the final round's own context decides `input_retry`; there is no `interim` to correct, so a refusal after an interim round leaves no event there.
- **Unchanged:** an interim request still opens a call context (it may send the session's deferred `connection` event), `tools/list` and discovery, intent capture (the retry repeats the arguments, `context` included), v1, and every call without `input_required`. A result with `inputRequests` / `requestState` but no `resultType` is rejected by v2's result validation and counted as one `error` / `server` event, as before.

### Fields of a pre-handler failure event

| Field | Value |
|-------|-------|
| `event_name` | `request.params.name` — for an unknown tool, the name the model asked for. The dashboard then lists it as a tool with a 100 % error rate, which is the honest signal ("the model keeps calling `search_flights`, which does not exist") |
| `status` / `error_category` | `error` / `validation` — for unknown, disabled, argument validation and task misconfiguration alike. All four are `InvalidParams`-class failures of the request itself; the MCP SDK hands them over as one text, so a finer split would mean parsing message prefixes. `error_message` carries the reason |
| `error_message` | the `isError` result's text (`createToolError`), PII-stripped, clamped — **gated on the resolved `outputValues`**: it is result-derived (#75 rule). As-is only with `inputValues` AND `rejectedInputValues`, because McpServer's text describes the rejected arguments and Zod 3 enum errors echo the received value. Otherwise `valueFreeRejection()`: the text as-is when it matches McpServer's tool-name-only wordings (`Tool <name> not found` / `disabled` / the two taskSupport texts, with `<name>` equal to the event's tool name), a fixed "Input validation error: …" reason for argument validation, and nothing for any other wording (fail closed) *(gates: inputValues 2026-10-13; rejectedInputValues + value-free reasons 2026-10-15, #123)* |
| `latency_ms` | **absent**. The handler never ran; there is no execution time to report, and a wall-clock value of ~0 ms would only drag the tool's latency percentiles down |
| `input_keys` / `input_types` / `input_values` / client meta | from the **raw** `request.params.arguments` and `extra`, under the tool's resolved capture flags (`resolveToolCapture(name)`, **also for a name that is not registered** — an override must hold for a tool a deployment registers conditionally while a client calls it from a cached schema; changed 2026-10-13). **Argument values only with `rejectedInputValues`** (default `false`, global and per tool, #123, 2026-10-15): a successful call stores `parseResult.data` — only what the schema accepted — while a rejected call's values are what it refused, model free text in an enum field included. Without the flag: `input_keys` / `input_types` only for the parameter names the registered schema declares (`declaredParamNames()` reads McpServer's registry; unknown tool or unreadable schema → none — an invented key can carry free text), `input_values` with only the `_`-prefixed request context (`_meta`, `_taskId`, `_requestInfo`, same `geo` rules), client meta as on success. None of this depends on `arguments` having been sent (it is optional in MCP) |
| `output_content` | the error result, under `outputValues` AND `inputValues` AND `rejectedInputValues` (same text as `error_message`) |
| `intent_signals` | whatever the intent wrapper captured — it sits outside the status wrapper, so `getCapturedIntent()` works and the captured arguments are already free of `context` |
| session / trace / platform | as for any call (`openCallContext`), including the deferred connection event on the first call of a session. If opening the context throws, the call runs without a frame (callback-only behaviour) — the wrapper sits outside McpServer's try/catch and must never fail the client's call |

### The post-handler case

`validateToolOutput()` failing is a server bug (the tool declares an `outputSchema` its own `structuredContent` does not satisfy). The callback's event keeps its latency and captured data; only `status`, `error_category: server` and the (output-gated) `error_message` change. Rare, but until now it was recorded as a success on every single call.

### Composition with the intent wrapper

Both wrap the same handler, so the order must be fixed in one place. `server/protocol.ts` owns the patching that `intent.ts` `install()` used to do — locating the low-level server, seeding, patching `setRequestHandler`, wrapping already-registered handlers, idempotency — and applies a list of wrappers **innermost first**: `[status, intent]` yields `intent(status(mcpHandler))`. The intent controller no longer installs itself; it exposes its call and list wrappers and the proxy composes them.

Status must be the inner wrapper: it then runs inside the intent store (so a pre-handler failure still carries `intent_signals`) and sees arguments with `context` already removed.

### The `initialize` tap (#170, 0.5.5)

`installProtocolWrappers()` also wraps the low-level server's `initialize` handler, through the same handler map and `compose()` guards: in place, because the `Server` constructor registers it before `withYavio()` runs (v1 `setRequestHandler(InitializeRequestSchema, …)`, v2 `setRequestHandler("initialize", …)`), and through the patched `setRequestHandler` for a later re-registration. The tap awaits the stored handler, records the result's `protocolVersion` in a module-level `WeakMap` keyed by the low-level server, and returns the result unchanged. A handler that throws throws the same error, and the tap's own read cannot fail the handshake; the client identity is still filled by `_oninitialize`, which runs inside it. It is the only record of the negotiated version on MCP SDK v1, whose `Server._oninitialize` keeps the client's identity and capabilities but not the version; on v2 it backs `getNegotiatedProtocolVersion()` (deprecated since 2.0.0), which is read first. `negotiatedProtocolVersion()` is the connection event's third source of `protocol_version`, after the 2026-07-28 envelope and the `mcp-protocol-version` header ([per-request-servers.md](./per-request-servers.md)).

### When the private API is missing

`installProtocolWrappers()` returns `false` when the server exposes no `server.setRequestHandler` (Skybridge-style facades in the test-suite, an MCP SDK that moved the field). Nothing else changes: no frame is ever opened, the callback wrapper sends immediately, and pre-handler failures stay invisible — today's behaviour, never worse. Intent capture already degrades the same way. So does the `initialize` tap (#170): without the handler map it is not installed, and a connection with neither a 2026-07-28 envelope nor an `mcp-protocol-version` header (v1 over stdio or in memory) keeps `protocol_version` unset, as before 0.5.5.

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
8. Per-tool `inputValues: false` → the validation event carries no inputs, client meta, `error_message` or `output_content`; `outputValues: false` → no `error_message`, status/category kept. The override also applies to a name this deployment never registered.
9. Tool registered on the **unwrapped** server under `withYavio()` → validation failure and success both produce **no** event, not even a connection event. (Under `createYavio().wrap()` such a tool is instrumented at wrap time, see [per-request-servers.md](./per-request-servers.md).)
10. Opening the call context throws → the client's call still succeeds, and the callback sends its event on its own.
10. Direct handler invocation without a frame → event sent immediately (the existing `proxy.test.ts` suite).
11. Server without the private API → callback path still emits (the existing Skybridge tests).
12. All existing intent tests pass unchanged after the install refactor.
13. *(#168)* `integration/mcp-v2.test.ts`, the real v2 client with an `elicitation/create` handler: on 2026-07-28 (accept, decline, two rounds, a `requestState`-only interim result, a final round that throws or fails its `outputSchema`, a client without the elicitation capability, `serverOnly: false`, a 2025-era client against a per-request host) and on the 2025 shim (accept with summed latency, two rounds, decline, a final output-schema failure, a final throw, a shim refusal, a URL elicitation after an interim round, `serverOnly: false`) one event each (none for the URL elicitation); a direct call returns the interim result as the same object, JSON-identical. `proxy.test.ts`: a v1 tool returning that shape is one ordinary event, a v2 retry context marks `input_retry`.

## Open Questions

- Task-based tools (`registerToolTask`) are not intercepted by the proxy at all today; their pre-handler failures are therefore not counted either (rule: no callback event + not instrumented → nothing). Separate issue if task tools ever ship in a Yavio-instrumented app. Documented in the README ("MCP 2026-07-28") and [server-sdk.md §3.1.3](./server-sdk.md#313-proxy-internals), and pinned by `integration/protocol.test.ts` on the v1 legs, refused call included (#172).
- A `context` sent from a cached schema **after intent capture was turned off** reaches the raw arguments of a validation-failure event (there is no intent wrapper to strip it). Edge of an edge; the text is PII-stripped like everything else. Noted, not handled.
