# Infrastructure Roadmap

## Phase 1: Database Schemas & Docker Foundation

- Docker Compose file with PostgreSQL + ClickHouse services
- PostgreSQL schema: users, workspaces, projects, api_keys, invitations, sessions
- ClickHouse schema: events table (including `user_id`, `user_traits` columns), sessions materialized view (including `user_id`), users materialized view, tool_registry
- Database migration tooling (Drizzle for Postgres, custom scripts for ClickHouse)
- Health check endpoints for both databases
- **Milestone:** `docker-compose up` starts databases, migrations run, health checks pass
