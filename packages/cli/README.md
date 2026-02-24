# @yavio/cli

CLI for setting up the Yavio SDK and managing self-hosted Yavio deployments.

## Install

```bash
npm install -g @yavio/cli
```

Or run directly:

```bash
npx @yavio/cli <command>
```

## Commands

### `yavio init`

Initialize SDK configuration in the current project. Creates a `.yaviorc.json` file and adds it to `.gitignore`.

```bash
yavio init
yavio init --api-key yav_... --endpoint https://ingest.example.com
```

### `yavio up`

Start the self-hosted Yavio platform via Docker Compose.

```bash
yavio up
yavio up --build          # rebuild images first
yavio up --prod           # use production compose overrides
yavio up -f ./compose.yml # custom compose file
```

### `yavio down`

Stop the platform. Data volumes are preserved.

```bash
yavio down
```

### `yavio status`

Show service health for Dashboard, Ingestion API, ClickHouse, and PostgreSQL.

```bash
yavio status
```

### `yavio logs [service]`

Tail logs for a specific service or all services.

```bash
yavio logs              # all services
yavio logs ingest       # just the ingest service
yavio logs -n 50        # last 50 lines
yavio logs --no-follow  # print and exit
```

Services: `dashboard`, `ingest`, `clickhouse`, `postgres`, `docs`

### `yavio update`

Pull latest Docker images and restart services.

```bash
yavio update
yavio update --all       # also update third-party images
yavio update --dry-run   # preview without pulling
```

### `yavio reset`

Wipe data volumes and reinitialize the platform. Requires confirmation.

```bash
yavio reset
yavio reset --keep-config  # only wipe ClickHouse events
```

### `yavio doctor`

Diagnose common setup issues — checks Node.js version, Docker availability, config files, service connectivity, and port conflicts.

```bash
yavio doctor
```

## Global Options

```
--verbose   Enable verbose output
--version   Show CLI version
--help      Show help
```

## Documentation

Full documentation is available at [docs.yavio.ai](https://docs.yavio.ai/docs).

## License

[MIT](./LICENSE)
