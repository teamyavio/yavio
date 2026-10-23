// @vitest-environment jsdom
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real SWR 2 in a real React root: what is under test is how many
// requests a failed analytics query makes on its own (#159).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 60 * 60 * 1000;

type QueryResult = ReturnType<typeof useAnalyticsQuery<unknown>>;

function answer(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let root: Root | undefined;

function renderQuery(): { current: QueryResult } {
  const result = {} as { current: QueryResult };
  function Probe() {
    result.current = useAnalyticsQuery({
      url: "/api/analytics/p1/funnels",
      queryString: "from=2026-01-01&to=2026-10-01",
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => {
    // A fresh cache per test, so no test sees another's error or data.
    root?.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <Probe />
      </SWRConfig>,
    );
  });
  return result;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // SWR's backoff is 5 s × 2^n × (0.5–1.5 random): pinned to × 1.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAnalyticsQuery background retries (#159)", () => {
  it.each([
    [
      400,
      "YAVIO-3407",
      "The database rejected this query. Retrying unchanged will fail the same way.",
    ],
    [
      422,
      "YAVIO-3408",
      "This query needs more memory than the database allows. Narrow the date range or simplify the query.",
    ],
    [504, "YAVIO-3405", "Analytics query timed out. Please try a smaller date range."],
  ])("does not retry a %i %s in the background", async (status, code, message) => {
    fetchMock.mockResolvedValue(answer(status, { error: message, code }));

    const result = renderQuery();
    await advance(HOUR);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toBe(message);
    expect(result.current.error).toMatchObject({ status, code });
  });

  it("retries a 502 with SWR's backoff and stops after five retries", async () => {
    fetchMock.mockResolvedValue(
      answer(502, { error: "Analytics query failed. Please try again later.", code: "YAVIO-3406" }),
    );

    const result = renderQuery();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry n waits 5 s × 2^n: 10 s, 20 s, 40 s, 80 s, 160 s — unchanged.
    let calls = 1;
    for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000]) {
      await advance(wait - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(++calls);
    }

    await advance(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.current.error).toMatchObject({ status: 502, code: "YAVIO-3406" });
  });

  it("retries a network failure, with the same cap", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderQuery();
    await advance(HOUR);

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("stops retrying once the transient failure turns into a deterministic one", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(502, { error: "try again later", code: "YAVIO-3406" }))
      .mockResolvedValue(answer(504, { error: "timed out", code: "YAVIO-3405" }));

    renderQuery();
    await advance(HOUR);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still refetches on an explicit retry, without restarting a loop", async () => {
    fetchMock.mockResolvedValue(answer(422, { error: "needs more memory", code: "YAVIO-3408" }));

    const result = renderQuery();
    await advance(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The page header's refresh button and "Try again" both call retry().
    await act(async () => {
      result.current.retry();
    });
    await advance(HOUR);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on focus, and refetches once per reconnect", async () => {
    fetchMock.mockResolvedValue(answer(422, { error: "needs more memory", code: "YAVIO-3408" }));

    renderQuery();
    await advance(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // SWR registers its focus listener as setTimeout.bind(fn), so the event
    // lands in the delay argument; the module's default cache, bound to the
    // real setTimeout at import, makes Node warn about the NaN delay.
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    // revalidateOnFocus is off: switching back to the tab sends nothing.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // revalidateOnReconnect (SWR's default) asks once when the browser comes
    // back online, and the deterministic answer is not retried from there.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
