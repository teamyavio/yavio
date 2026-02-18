# Ingestion API Roadmap

## Phase 2: Ingestion API

- ~~Fastify/Hono HTTP server setup~~ done
- `POST /v1/events` endpoint with request parsing
- API key validation middleware (PostgreSQL lookup + in-memory cache)
- `POST /v1/widget-tokens` endpoint (mints short-lived, trace-scoped JWTs for widget auth)
- JWT signing with internal `JWT_SECRET` + JWT verification middleware
- Dual auth: API key resolution (server SDK) and JWT verification (widget SDK)
- Schema validation middleware
- PII stripping engine (ported from original spec, now server-side)
- Rate limiting middleware (per API key + per widget JWT)
- ClickHouse batch writer (buffer + timed flush)
- Batch-level trace validation: reject widget JWT batches where any event's `traceId` does not match the JWT `tid` claim
- Event field size limits: per-field max sizes, total event size limit, batch size limit (see event-pipeline.md §6.2.8)
- ~~CORS configuration for widget requests~~ done
- ~~`GET /health` endpoint (liveness: process up; readiness: ClickHouse + PostgreSQL connectivity check)~~ done
- ~~Dockerfile for ingestion service~~ done
- Unit tests: PII stripping, schema validation, API key resolution, JWT minting/verification
- API tests: auth (API key + JWT), rate limiting, schema, CORS, batch processing, widget-tokens endpoint
- Integration tests: HTTP request → ClickHouse write
- **Milestone:** Ingestion API accepts events via `curl` and writes to ClickHouse. Widget token endpoint mints valid JWTs.
