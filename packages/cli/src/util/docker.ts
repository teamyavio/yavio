import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Options as ExecaOptions, ResultPromise } from "execa";
import { execa } from "execa";

export interface ContainerInfo {
  Name: string;
  Service: string;
  State: string;
  Status: string;
  Health: string;
}

/**
 * Check if `docker` CLI is available.
 */
export async function hasDocker(): Promise<boolean> {
  try {
    await execa("docker", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if `docker compose` is available.
 */
export async function hasDockerCompose(): Promise<boolean> {
  try {
    await execa("docker", ["compose", "version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse Docker version string (e.g., "Docker version 27.0.1, build ...").
 */
export async function getDockerVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa("docker", ["--version"]);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Parse docker compose version string.
 */
export async function getComposeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa("docker", ["compose", "version"]);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the compose file path.
 * Priority: `--file` flag → `docker-compose.yml` in cwd → error.
 */
export function resolveComposeFile(fileFlag?: string): string {
  if (fileFlag) {
    const resolved = resolve(fileFlag);
    if (!existsSync(resolved)) {
      throw new Error(`Compose file not found: ${resolved}`);
    }
    return resolved;
  }
  const cwdCompose = resolve("docker-compose.yml");
  if (existsSync(cwdCompose)) {
    return cwdCompose;
  }
  throw new Error(
    "No docker-compose.yml found in current directory. Use --file to specify the path.",
  );
}

/**
 * Execute a docker compose command.
 * Pass `files` to use multiple compose files (e.g. base + prod overlay).
 */
export function execCompose(
  args: string[],
  opts?: { file?: string; files?: string[]; stdio?: ExecaOptions["stdio"] },
): ResultPromise {
  const fileArgs = opts?.files
    ? opts.files.flatMap((f) => ["-f", f])
    : ["-f", resolveComposeFile(opts?.file)];
  return execa("docker", ["compose", ...fileArgs, ...args], {
    stdio: opts?.stdio ?? "pipe",
  });
}

/**
 * Derive the Compose project name from the compose file path.
 * Matches Docker Compose v2 default: lowercase directory basename, non-alphanumeric stripped.
 */
export function getComposeProjectName(file?: string): string {
  const composeFile = resolveComposeFile(file);
  return basename(dirname(composeFile))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Remove specific Docker volumes by name.
 */
export async function removeVolumes(volumeNames: string[]): Promise<void> {
  if (volumeNames.length === 0) return;
  await execa("docker", ["volume", "rm", "--force", ...volumeNames]);
}

/**
 * Get container status from `docker compose ps --format json`.
 */
export async function getContainerStatus(file?: string): Promise<ContainerInfo[]> {
  try {
    const composeFile = resolveComposeFile(file);
    const { stdout } = await execa("docker", [
      "compose",
      "-f",
      composeFile,
      "ps",
      "--format",
      "json",
    ]);
    if (!stdout.trim()) return [];
    // docker compose ps --format json outputs one JSON object per line
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ContainerInfo);
  } catch {
    return [];
  }
}
