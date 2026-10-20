# `input_values` Extra Fields (`_`-prefixed)

**Status:** Implemented 2026-09-03 (#76; proposed 2026-08-26, reviewed 2026-08-26 with corrections folded in, geo gating decided 2026-09-03; `geo: "country"` added 2026-10-13, #82) · **Packages:** sdk, docs · **Version:** patch

## Current Behaviour

`extractInputValues()` (`src/server/proxy.ts`) deep-clones the tool arguments and merges serialisable parts of `RequestHandlerExtra` under `_`-prefixed keys:

| Key | Source | Content | Analytical value |
|-----|--------|---------|------------------|
| `_meta` | `extra._meta` (verbatim clone) | ChatGPT: `openai/userAgent`, `openai/locale`, `openai/userLocation` (city, region, country, timezone, **latitude, longitude**), `openai/subject`, `openai/session`, `openai/organization`, client capabilities | Richest client context available; overlaps with the first-class columns `locale`, `end_user_agent`, `subject_id`, `country_code` |
| `_sessionId` | `extra.sessionId` | the **raw** `Mcp-Session-Id` (stateful transports only) | None in practice: 0 occurrences fleet-wide (0 of ~5 100 calls on 2026-08-26, 0 of ~1 200 in the July analysis — every app runs a stateless transport); log correlation is served by the hashed `session_id` column plus the `traceparent` header in `_requestInfo` |
| `_requestId` | `extra.requestId` | JSON-RPC request id — a per-connection counter; ChatGPT reconnects per call, so it is almost always a small integer | None |
| `_taskId` | `extra.taskId` | MCP task id (task-based flows) | Correlation for task flows |
| `_taskRequestedTtl` | `extra.taskRequestedTtl` | requested TTL of a task | None |
| `_requestInfo` | `extra.requestInfo` via `sanitizeRequestInfo()` | allow-listed headers (`user-agent`, `accept-language`, `x-anthropic-client`, `mcp-protocol-version`, `traceparent`) + URL without query | Which client/protocol called; `traceparent` for log correlation |

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

## Changes

| Package | Change |
|---------|--------|
| sdk | `extractInputValues()`: remove `_requestId`, `_taskRequestedTtl`, `_sessionId`; geo-gated `userLocation` removal (decided, in scope); README section listing every `_` field, the disclosure note and the intentional duplication. |
| specs / docs | `.specs/metrics/events.md`: `input_values` row → "tool arguments plus `_meta`, `_taskId`, `_requestInfo` (see server-sdk.md)"; docs site captured-data page. |

## Tests

`proxy.test.ts` `extractInputValues`: `_requestId`/`_taskRequestedTtl`/`_sessionId` absent; `_meta`, `_taskId`, `_requestInfo` present; header allow-list unchanged (five headers); `geo:false` → no `openai/userLocation` at all.

## Compatibility

Patch release. No consumer of the removed keys exists in this repository.
