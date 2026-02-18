# 10. Testing Strategy

Testing is organized per service. Each service folder contains a `testing.md` with detailed test categories and key scenarios.

## Per-Service Testing Specs

| Service | Testing Spec | Priority Summary |
|---------|-------------|-----------------|
| SDK | [sdk/testing.md](./sdk/testing.md) | Unit + integration tests (P0), React SDK tests (P1) |
| Ingestion API | [ingest/testing.md](./ingest/testing.md) | Unit + API + integration tests (all P0) |
| Dashboard | [dashboard/testing.md](./dashboard/testing.md) | Auth + workspace tests (P0), API routes + components (P1), E2E (P2) |
| Infrastructure | [infrastructure/testing.md](./infrastructure/testing.md) | Docker + migration tests (P1), performance (P2), end-to-end scenarios |
