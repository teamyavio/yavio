# `input_values` Extra Fields (`_`-prefixed)

**Status:** Proposed (2026-08-26), reviewed 2026-08-26 (#76, corrections folded in) · **Packages:** sdk, docs · **Version:** patch

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

Live counts, tool_call events, 2026-08-26: `_requestId` on 497/497 (Commerce for Agents) and 67/68 (Preisvergleich); `_taskId`/`_taskRequestedTtl` 0 everywhere; `_sessionId` 0 everywhere; `_meta.openai/userLocation.latitude` on 66 and 24 events respectively.

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

## Changes

| Package | Change |
|---------|--------|
| sdk | `extractInputValues()`: remove `_requestId`, `_taskRequestedTtl`, `_sessionId`; geo-gated `userLocation` removal (decided, in scope); README section listing every `_` field, the disclosure note and the intentional duplication. |
| specs / docs | `.specs/metrics/events.md`: `input_values` row → "tool arguments plus `_meta`, `_taskId`, `_requestInfo` (see server-sdk.md)"; docs site captured-data page. |

## Tests

`proxy.test.ts` `extractInputValues`: `_requestId`/`_taskRequestedTtl`/`_sessionId` absent; `_meta`, `_taskId`, `_requestInfo` present; header allow-list unchanged (five headers); `geo:false` → no `openai/userLocation` at all.

## Compatibility

Patch release. No consumer of the removed keys exists in this repository.
