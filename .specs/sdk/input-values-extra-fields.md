# `input_values` Extra Fields (`_`-prefixed)

**Status:** Implemented 2026-09-03 (#76; proposed 2026-08-26, reviewed 2026-08-26 with corrections folded in, geo gating decided 2026-09-03; `geo: "country"` added 2026-10-13, #82; SEP-414 trace context 2026-10-25, #173; `capture.conversationId` 2026-10-26, #204) · **Packages:** sdk, docs · **Version:** patch

## Current Behaviour

`extractInputValues()` (`src/server/proxy.ts`) deep-clones the tool arguments and merges serialisable parts of `RequestHandlerExtra` under `_`-prefixed keys:

| Key | Source | Content | Analytical value |
|-----|--------|---------|------------------|
| `_meta` | `extra._meta` (verbatim clone) | ChatGPT: `openai/userAgent`, `openai/locale`, `openai/userLocation` (city, region, country, timezone, **latitude, longitude**), `openai/subject`, `openai/session`, `openai/organization`, client capabilities | Richest client context available; overlaps with the first-class columns `locale`, `end_user_agent`, `subject_id`, `country_code` |
| `_sessionId` | `extra.sessionId` | the **raw** `Mcp-Session-Id` (stateful transports only) | None in practice: 0 occurrences fleet-wide (0 of ~5 100 calls on 2026-08-26, 0 of ~1 200 in the July analysis — every app runs a stateless transport); log correlation is served by the hashed `session_id` column plus the traceparent (the `traceparent` header in `_requestInfo` until 0.5.5; `metadata.traceparent` since, #173) |
| `_requestId` | `extra.requestId` | JSON-RPC request id — a per-connection counter; ChatGPT reconnects per call, so it is almost always a small integer | None |
| `_taskId` | `extra.taskId` | MCP task id (task-based flows) | Correlation for task flows |
| `_taskRequestedTtl` | `extra.taskRequestedTtl` | requested TTL of a task | None |
| `_requestInfo` | `extra.requestInfo` via `sanitizeRequestInfo()` | allow-listed headers (`user-agent`, `accept-language`, `x-anthropic-client`, `mcp-protocol-version`; `traceparent` too until 0.5.5, now `metadata.traceparent`, #173) + the URL without query only when `requestInfo.url` is a string, which the MCP SDK's own transports do not pass (v1: none before 1.27, a `URL` object from 1.27, dropped; v2: not read, see `per-request-servers.md`) | Which client/protocol called |

The README documents only `_requestInfo` (and understates it — it lists two headers, the code keeps five). `.specs/metrics/events.md` does not mention the extra fields at all.

Live counts, tool_call events, 2026-08-26: `_requestId` on 497/497 (an integration) and 67/68 (a second integration); `_taskId`/`_taskRequestedTtl` 0 everywhere; `_sessionId` 0 everywhere; `_meta.openai/userLocation.latitude` on 66 and 24 events respectively.

## Decisions

1. **`_meta` stays as it is** (product decision, Marcel, 2026-08-26): the verbatim client metadata is wanted for detailed user analytics. Consequence to document, not to soften: `input_values` then contains the user's approximate position including coordinates and the platform's stable user id on every call. Customers must disclose this in their privacy policy; the SDK README and the docs site say so explicitly, next to the existing intent-capture privacy note. State in the same place that `_meta` intentionally **duplicates** the first-class columns `subject_id`, `locale`, `end_user_agent`, `country_code`, so nobody later "deduplicates" the columns away.
2. **Drop the fields without analytical value:** `_requestId`, `_taskRequestedTtl`, and — changed after review — **`_sessionId`**: it is the raw `Mcp-Session-Id` while the main `session_id` column is SHA-256-hashed on purpose (`core/ids.ts` `deriveSessionId`), it is empirically dead, and a raw session identifier in `input_values` is exactly the kind of field the ChatGPT app-store decline over session-id tracking was about. (Hashing it like `deriveSessionId()` would be the alternative if a consumer ever appears.)
3. **Keep** `_taskId` (never seen, harmless, task flows) and `_requestInfo`. Keep the flat `_` prefix — nothing in dashboard or ingest reads these keys, and a nested `_extra` object would be a change without a consumer.
4. **Document all of them** in one place (README "Captured data" + `.specs/metrics/events.md` `input_values` row), including the header allow-list as implemented.

## Decided: gate `openai/userLocation` behind `capture.geo`

`capture.geo` currently governs only the first-class `country_code`. A customer who sets `geo: false` still ships `_meta["openai/userLocation"]` — city, region, timezone **and coordinates** — inside `input_values`. `extractClientMeta()`'s own doc comment says "city and coordinates never leave the process", which the verbatim clone contradicts on every ChatGPT web call, and the README sells `geo` as "capture geo data". With `geo: false`, delete the **whole** `openai/userLocation` object from the `_meta` clone. Five lines in `extractInputValues()`, one test. Default behaviour unchanged (`geo` defaults to `true`).

**Decided yes — Marcel, 2026-09-03.** Breakage analysis done before deciding:

- `extractInputValues()` deep-clones `_meta` (`clone._meta = JSON.parse(JSON.stringify(ex._meta))`, `proxy.ts:574`), so deleting the key from the clone cannot affect the `_meta` the tool handler receives. This was the only real risk.
- Nothing in dashboard, ingest or db reads `_meta["openai/userLocation"]` out of `input_values`; the only functional reader of `userLocation` anywhere is `extractClientMeta()` (`proxy.ts:639`), which is **already** gated on `geoEnabled` and only derives `country_code`.
- Affects only integrators who explicitly set `geo: false`, and only by removing data they asked not to collect. Rows already in ClickHouse are untouched.
- Existing coverage to extend: `proxy.test.ts` "omits the country when capture.geo is off, keeps the rest".

## Decided: `geo: "country"` (#82)

**Decided — Marcel, 2026-10-13; ships with 0.4.0.** `geo` was all-or-nothing: the country came with city, region, timezone and coordinates or not at all. A privacy review that wants country-level analytics without precise location had no setting. `capture.geo` is now `boolean | "country"`:

| `geo` | `country_code` | `input_values._meta["openai/userLocation"]` |
|---|---|---|
| `true` (default, unchanged) | ✅ | verbatim |
| `"country"` | ✅ | a **new** `{ country }` object; the key is removed when there is no valid 2-letter country |
| `false` (unchanged) | — | removed |

- **Allow-list, not deny-list:** the reduced object is built, not copied-and-pruned, so a field the platform adds later (postal code, accuracy, …) cannot leak through.
- **One country check** (`locationCountry()` in `proxy.ts`) feeds both the column and the `_meta` reduction, so they cannot disagree.
- **Fails closed:** `resolveConfig()` accepts exactly `true`, `false`, `"country"`. Anything else — `"false"` from a hand-written `.yaviorc.json` is truthy — becomes `false` with one `YAVIO-1006` warning per process (stateless servers resolve the config per request). **Extended 2026-10-14 (0.4.0 refinement):** the same for every capture flag — `inputValues`, `outputValues`, `tokens`, `retries` accept exactly `true`/`false`; one warning per flag and process. Per-tool `tools` overrides (`inputValues`, `outputValues`, `rejectedInputValues`, `intent`) fail closed the same way — a dropped `"false"` would have left the one tool the integrator meant to protect on the global default.
- Per-tool overrides stay without `geo`.

## Decided: `geo: "region"` and the top-level `timezone` (#127)

**Decided — Marcel, 2026-10-20; ships with 0.4.1.** Nothing sat between `"country"` and "everything including coordinates", so a breakdown by state or province needed `true`. A fourth value, and a new first-class `region` field (ingest column: #128, dashboard: #129):

| `geo` | `country_code` | `region` | `input_values._meta["openai/userLocation"]` | rest of `_meta` |
|---|---|---|---|---|
| `true` (default, unchanged) | ✅ | ✅ | verbatim | verbatim |
| `"region"` | ✅ | ✅ | a **new** `{ country, region }` object (`{ country }` without a valid region, removed without a valid country) | known keys only (**fix**) |
| `"country"` | ✅ | — | `{ country }` | known keys only (**fix**) |
| `false` | — | — | removed | known keys only (**fix**) |

- **The timezone leak.** ChatGPT sends the user's IANA zone a second time as a top-level `_meta.timezone`, outside `userLocation`, on most calls that carry a location. Until 0.4.1 the reduction only touched `userLocation`, so `"country"` and `false` stored it, against the README. In the US the zone is finer than the country (`America/Indiana/*` is close to county level). The test fixture had no such key, which is why the tests were green. It was live: an integration on 0.4.0 with `geo: "country"` stored `timezone` and, from ~2026-10-15, the new `timezone_offset_minutes`.
- **Known keys only — Marcel, 2026-10-20.** A first fix dropped keys whose name matched `/location|time_?zone|…/`. Rejected: ChatGPT added seven undocumented top-level keys in two months (`itemId`, `callId`, `sessionId`, `windowId`, `openai/request_id`, `traceparent`, `timezone_offset_minutes`), one of them location data, and a pattern misses `tz`, `utc_offset` or `openai/postalCode` while hitting `allocation`. `reduceMeta()` now keeps, under every `geo` but `true`, exactly `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` (`KNOWN_META_KEYS`) plus the rebuilt `openai/userLocation`. The conversation and request ids, `traceparent`, `openai/organization`, the client capabilities, `progressToken` and everything else are dropped (an intermediate version kept the client ids; Marcel narrowed the list to these four). The names of dropped keys go to `input_values._metaDroppedKeys` (MCP key format, ≤ 64 characters, ≤ 20, sorted; never values); a name with a run of 8+ hex digits, a malformed name or one past the cap is only counted, in `_metaDroppedUnnamed`. The allow-listed request headers (`_requestInfo`) are unchanged. Same reasoning as the header allowlist (`CAPTURED_HEADERS`).
- **Considered: a separate setting for unknown keys, independent of `geo`.** Its default decides everything: "keep all" would leave a `"country"` app open to the next location key, "known only" would change `geo: true` apps against the 2026-08-26 decision, and "follow `geo`" is this rule plus a switch. Add the switch when an app needs `geo: true` with known keys only.
- **One region rule** for SDK and ingest: `normalizeRegionName()` in `@yavio/shared/geo` (NFC, typographic apostrophes and dashes folded, spaces collapsed, at most 64 characters of letters, marks, spaces and `-'.,()/&·`, at least one letter; no digits, `@` or control characters). `locationRegion()` applies it only next to the country `locationCountry()` returned, and feeds both the field and the `_meta` reduction, so the column and `_meta` agree. Not mapped to ISO 3166-2 ("Hesse", "State of Berlin").
- **City-states:** there the region is the city ("State of Berlin", Hamburg, Bremen, Vienna, Washington, D.C.). Documented in the README and configuration docs rather than special-cased.
- **Use sites compare exact values** (`geo === "country" || geo === "region"`), never truthiness, so a geo that skipped `resolveGeo` fails closed there too.
- Still coupled to `inputValues` like every client-metadata field (see per-tool-capture.md).

## Decided: SEP-414 trace context (#173)

**Decided 2026-10-25 (the issue's recommended defaults); ships with 0.5.5.** SEP-414 (MCP 2026-07-28) puts W3C trace context into the request `_meta`: `traceparent`, `tracestate` and `baggage` (the v2 packages export the key names from 2.0.0 on; neither MCP SDK reads or sets them). Over HTTP a client may also send a `traceparent` header. Until 0.5.5, `geo: true`, the default, kept all three verbatim in `_meta`. Baggage is application context (`user.id=…,tenant.id=…`) that OpenTelemetry's default propagators send whenever any is active, with values percent-encoded, so an email in it has no `@` for the email pattern. The header was in `_requestInfo` as sent, and the other `geo` values dropped the `_meta` copy, so a stdio server stored no trace context at all.

| `_meta` key | `geo: true` | `"region"` / `"country"` / `false` |
|---|---|---|
| `baggage` | dropped, name in `_metaDroppedKeys` (was verbatim) | dropped, named (unchanged) |
| `tracestate` | dropped, named (was verbatim) | dropped, named (unchanged) |
| a valid `traceparent` | moved to `metadata.traceparent`, not named (was verbatim) | moved to `metadata.traceparent`, not named (was dropped and named) |
| an invalid `traceparent`, or one under another spelling (`Traceparent`) | dropped, named (was verbatim) | dropped, named (unchanged) |
| `Correlation-Context` (review round 1) | dropped, named (was verbatim) | dropped, named (unchanged) |
| `_dd_trace_context` (review round 2) | dropped, named (was verbatim) | dropped, named (was counted: a leading `_` is not recordable) |
| `uberctx-…`, `ot-baggage-…` (review round 1) | dropped, counted in `_metaDroppedUnnamed` (was verbatim) | dropped, counted (was named: the member's name) |
| every other key, `Request-Id` included | verbatim (unchanged) | known keys only (unchanged) |

All names are matched in any letter case (`Baggage`, `TraceState`); only the exact key `traceparent` is lifted, else the one at exactly `_dd_trace_context.traceparent`.

- **Other baggage carriers (review round 1).** The C# MCP SDK propagates through `DistributedContextPropagator.Current`, whose default on .NET 8 and 9 (`LegacyPropagator`) writes baggage as `Correlation-Context` (and an id as `Request-Id`); .NET 10 switched to W3C, but .NET 8 is LTS. Jaeger (`uberctx-<member>`) and OpenTracing (`ot-baggage-<member>`) carry one member per key, the member's name in the key, so those keys are counted, not named. Other vendors' keys (`sentry-trace`, `b3`, `uber-trace-id`) are ids and stay like any other key; a vendor's own baggage format under another key is not recognised.
- **Datadog (review round 2).** Datadog's MCP instrumentation, on by default in dd-trace-js (`datadog-instrumentations/src/modelcontextprotocol-sdk.js`, `DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'`) and dd-trace-py (`contrib/internal/mcp/patch.py`), injects its whole text map into one `_meta` object: `x-datadog-trace-id`, `-parent-id`, `-sampling-priority`, `x-datadog-tags` (which can carry `_dd.p.usr.id`, a base64 user id) and, with the default inject styles `datadog, tracecontext, baggage`, a `traceparent`, a `tracestate` and the baggage. The key is dropped under every `geo` and named: it is a fixed vendor key, not data, like `baggage`, and its name says which clients send Datadog context, which a count would not (so the `recordable()` check, which refuses its leading `_`, is skipped for the fixed trace-context names). A valid `traceparent` at exactly `_dd_trace_context.traceparent` is the last source, after `_meta.traceparent` and the header.
- **Names only.** `_metaDroppedKeys` thus also appears under `geo: true`, for the trace-context keys only. Only the `_meta` key's name is recorded, never a baggage member's (`user.id`, `tenant.id`): the integrator's upstream services pick those, a key can name a customer or a cohort, and Yavio has no use for them.
- **Valid** (`traceparentOf()`, `core/trace-context.ts`, which uses `isTraceparent()` from `@yavio/shared/pii`, the check both PII strippers use since #182): exactly `^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$` (55 characters), version not `ff`, neither id all zeros (W3C Trace Context §3.2.2). Not lifted: a non-string, upper case, padding or a trailing newline, a joined or repeated header, a future version with extra fields (§3.2.4).
- **Source:** `_meta.traceparent` first, because it is what the MCP client attached and the only carrier on stdio; else the HTTP header, which any hop on the way can set; else Datadog's `_meta._dd_trace_context.traceparent` (review round 2). `traceparent` left `CAPTURED_HEADERS`, so `_requestInfo` keeps four headers. Stored once.
- **Where:** `metadata.traceparent` on the `tool_call`, one object with #168's `input_rounds` / `input_retry`. Rejected: `input_values._traceparent` (missing for a tool without arguments, which has no `input_values`, and lost with the rest when `input_values` exceeds 10 KB) and a column (migration, shared schema, ingest and dashboard; worth it once a read-side feature filters or links by trace id). Query: `JSONExtractString(metadata, 'traceparent')`; the trace id is its second field.
- **When:** under `capture.inputValues` like the client metadata, per-tool overrides included; under every `geo`; for tools without arguments too; on successful, thrown, `isError` and rejected (`validation`) calls. New under `"region"`, `"country"` and `false`: a traceparent that arrives only in `_meta` (stdio, VS Code) is now stored. It is a random id, and these settings already stored it for HTTP clients.
- **`tracestate` is dropped under `geo: true` too:** vendor-opaque, up to 32 members of 256 characters, meaningless without that vendor's backend, and correlation needs only `traceparent`. W3C §6.2 asks vendors to keep PII out of it, which is a rule for vendors, not a guarantee to the receiver.
- **PII stripper:** both strippers (SDK `core/pii.ts`, ingest `lib/pii-stripper.ts`) return a string that is exactly a valid traceparent unchanged. Their phone pattern (ten decimal digits and a word boundary) cut ~1.9 % of valid ones: a 32- or 16-digit hex id ends in ten decimal digits with probability (10/16)^10 each, and the W3C example `…-b7ad6b7169203331-01` is among them. A path exemption for `metadata.traceparent` alone was rejected: it would let any text under that key past the stripper. The same false positive on UUIDs and other hex ids in `input_values` and `output_content` was #182: since SDK 0.5.6 and the matching ingest the string rules live once in `@yavio/shared/pii`, UUID-shaped and traceparent-shaped values standing alone (any letter case, inside text too, not glued to a letter or digit) are masked before the digit patterns run, and those patterns need a boundary on both sides, so such a traceparent is not cut, exact or not. The ingest half ships with the next ingest deploy, no migration.
- Rows stored before keep `input_values._meta.baggage` / `tracestate` until the 13-month TTL; nothing is backfilled.

## Decided: `capture.conversationId` (#204)

**Decided 2026-10-26 (the issue's proposal); ships with 0.5.6, no change to the default.** `input_values._meta` stored the platform's conversation id in plain text, and no setting removed it: `openai/session` is one of the four `KNOWN_META_KEYS`, and `geo: true`, the default, also keeps ChatGPT's top-level `sessionId` and `windowId` (in ChatGPT traffic each maps one to one to `openai/session`), VS Code's `vscode.conversationId` and the Codex CLI's `threadId`. Without an `Mcp-Session-Id` they add no metric: `session_id` is then `deriveSessionId()` of the same key (`findSessionKey()`, `server/session-key.ts`), and dashboard, ingest and db read sessions only from `session_id`. On a stateful transport `findSessionKey()` prefers the `Mcp-Session-Id`, so `session_id` hashes the transport's session and the raw conversation id is the only per-conversation id in the event; `conversationId: false` removes that too, which the docs say (review round 1). An integrator who has to justify each stored field can explain the hashed `session_id`, not the raw duplicates. The rule #76 applied to `_sessionId`. A new capture flag, `conversationId: boolean`, default `true`:

| `_meta` key | `conversationId: true` (default) | `conversationId: false` |
|---|---|---|
| `openai/session` | kept under every `geo` (a `KNOWN_META_KEYS` member) | dropped, named in `_metaDroppedKeys` |
| `sessionId`, `windowId` (ChatGPT, top level) | kept under `geo: true`; dropped by the allowlist otherwise | dropped, named, under every `geo` |
| `vscode.conversationId` | kept under `geo: true`; dropped by the allowlist otherwise | dropped, named, under every `geo` |
| `threadId`, from any client | kept under `geo: true`; dropped by the allowlist otherwise | dropped, named, under every `geo` |
| every other key | as `geo` decides (unchanged) | as `geo` decides (unchanged) |

- **One set**, `CONVERSATION_META_KEYS`, next to `KNOWN_META_KEYS` in `proxy.ts`, with a comment per key; a new conversation key goes there. Exact names, as `findSessionKey()` reads them: unlike the trace-context keys, which arrive in any letter case through HTTP-header conventions, these are written by the platform under one spelling.
- **`threadId` from any client:** only the Codex CLI's is a session key (`codex_thread`), but for a flag that removes ids removing more is the safe direction.
- **Under `"region"`, `"country"` and `false`** the allowlist drops all of them but `openai/session` already; there the flag removes `openai/session`, and the captured `_meta` keeps three known keys instead of four.
- **Named like every dropped key:** a conversation key that was sent goes to `_metaDroppedKeys`, with the same sorting and the 20-name cap (past it, counted in `_metaDroppedUnnamed`). Under `geo: true` the field then appears for these keys too, not only for the trace context.
- **`true` is byte-identical to before:** reduceMeta's branch for these keys runs only when the flag is not `true`, so the captured `input_values` of every `geo` is the same as before the flag (test: the same literals pass on the commit before #204).
- **Sessions unchanged:** the session key is read from the handler's `_meta` (`ex.meta`), never from the reduced clone, so `session_id` and `session_source` are the same with the flag on and off, and the handler receives the full `_meta` (the clone is a deep copy). The integrator's `sessionKey` still receives the full `_meta` as well.
- **Fails closed:** in `BOOLEAN_CAPTURE_FLAGS`, so a value other than `true` or `false` (a `"no"` from `.yaviorc.json`, `0`) becomes `false` with one `YAVIO-1006` warning; `undefined` keeps the default. reduceMeta compares exact values (`conversationId !== true` drops), like the `geo` use sites, so a config that skipped `resolveConfig()` drops the keys too.
- **Global only, not in `ToolCaptureOverride`:** a per-tool value would split one conversation's events into rows with the id and rows without it. A per-tool `inputValues: false` already removes all of `_meta` for that tool. A `conversationId` or `geo` key in a `tools` entry (`.yaviorc.json`, untyped JS) is ignored, with one `YAVIO-1006` warning per tool, flag and process when its value differs from the resolved global one (`GLOBAL_ONLY_CAPTURE_KEYS` in `core/config.ts`; review round 1): ignoring a privacy setting without a word is fail-open. A value equal to the global one changes nothing and logs nothing (review round 2). The global value applies.
- **Public type optional, resolved type required (review round 1):** `CaptureConfig.conversationId` is optional, so a `CaptureConfig` an app typed in full before 0.5.6 still compiles; `ResolvedCaptureConfig = Required<CaptureConfig>` is what `YavioConfig.capture` and a tool's resolved capture hold, the split `IntentOptions` / `IntentConfig` already makes. `check-package.mjs` compiles such a literal against the packed declarations.
- **Pseudonymous, not anonymous:** `deriveSessionId()` is an unkeyed SHA-256, so whoever holds the raw id (the platform, the integrator's own logs) can compute `session_id` again. The docs keep calling it pseudonymous. A keyed hash would change every `session_id` across versions; out of scope.
- **Forward only:** events stored before the flag is set keep their raw ids until the 13-month TTL or the project's shorter retention. Removing them from stored events is an operator task, not part of this change.
- **Not covered:** the user id, `openai/subject`, stored raw in `_meta` and as the first-class `subject_id` that user stitching (#89) relies on: removing it from `_meta` alone would not remove it, so it is left for its own issue. The per-call ids `callId`, `itemId`, `openai/request_id` name one call, not a conversation; every `geo` but `true` drops them.

## Changes

| Package | Change |
|---------|--------|
| sdk | `extractInputValues()`: remove `_requestId`, `_taskRequestedTtl`, `_sessionId`; geo-gated `userLocation` removal (decided, in scope); README section listing every `_` field, the disclosure note and the intentional duplication. |
| specs / docs | `.specs/metrics/events.md`: `input_values` row → "tool arguments plus `_meta`, `_taskId`, `_requestInfo` (see server-sdk.md)"; docs site captured-data page. |

## Tests

`proxy.test.ts` `extractInputValues`: `_requestId`/`_taskRequestedTtl`/`_sessionId` absent; `_meta`, `_taskId`, `_requestInfo` present; header allow-list unchanged (five headers; four since #173); `geo:false` → no `openai/userLocation` at all.

#173: `proxy.test.ts` "SEP-414 trace context (#173)" (every `geo`, the lift and its sources, eleven invalid values, a schema-less tool, thrown / `isError` / retried calls, `inputValues: false` global and per tool), `events.test.ts` (the `metadata` merge), `pii.test.ts`, `mcp-v2.test.ts` (2026-07-28 per-request and `serveStdio`, with v2's own key constants), `stateless-e2e.test.ts` (v1 stateless HTTP); ingest `pii-stripper.test.ts` and `api/events-processing.test.ts`.

#204: `proxy.test.ts` "capture.conversationId (#204)" (every `geo`: the flag on byte-identical to before, off with the remaining keys and `_metaDroppedKeys`, three known keys instead of four, the 20-name cap; `session_id` and `session_source` identical on and off for ChatGPT, VS Code and the Codex CLI; the handler's `_meta` untouched; the thrown path; a value that skipped `resolveConfig()`), `config.test.ts` (default, `undefined`, invalid values with `YAVIO-1006`, `.yaviorc.json`, no per-tool override), `integration/protocol.test.ts` (a `validation` event, with and without `rejectedInputValues`), `integration/mcp-v2.test.ts` (v2 legacy era, `_meta` from `ctx.mcpReq`; 2026-07-28 per-request host from `createYavio()` options, one session across instances). Review round 1: an `isError` result; a per-tool `inputValues: true` under a global `false`; the byte-identical test for a VS Code / Codex-shaped `_meta` with trace context under every `geo`; a `CaptureConfig` literal without the field (`config.test.ts`, and `check-package.mjs` against the packed declarations); the `YAVIO-1006` line for a `geo` or `conversationId` in a `tools` entry, from the options and from `.yaviorc.json`.

## Compatibility

Patch release. No consumer of the removed keys exists in this repository.
