export interface HealthResult {
  ok: boolean;
  status: number;
  latency: number;
}

/**
 * Check health of a URL with timeout.
 */
export async function checkHealth(url: string, timeoutMs = 5000): Promise<HealthResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: res.ok,
      status: res.status,
      latency: Date.now() - start,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      latency: Date.now() - start,
    };
  }
}

/**
 * Typed JSON fetch helper.
 */
export async function fetchJson<T>(
  url: string,
  opts?: { timeout?: number },
): Promise<{ ok: boolean; data: T | null; status: number }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts?.timeout ?? 5000),
    });
    if (!res.ok) {
      return { ok: false, data: null, status: res.status };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}
