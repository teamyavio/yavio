import { ErrorAlert } from "@/components/analytics/error-alert";
import { AnalyticsRequestError } from "@/lib/analytics/request";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w1/p1/funnels",
  useSearchParams: () => new URLSearchParams("from=2026-01-01&to=2026-10-01"),
}));

const retry = () => {};

describe("ErrorAlert (#159)", () => {
  it.each([
    [
      "400 query rejected",
      new AnalyticsRequestError(
        "The database rejected this query. Retrying unchanged will fail the same way.",
        400,
        "YAVIO-3407",
      ),
    ],
    [
      "422 query memory limit",
      new AnalyticsRequestError(
        "This query needs more memory than the database allows. Narrow the date range or simplify the query.",
        422,
        "YAVIO-3408",
      ),
    ],
    [
      "504 query timed out",
      new AnalyticsRequestError(
        "Analytics query timed out. Please try a smaller date range.",
        504,
        "YAVIO-3405",
      ),
    ],
  ])("shows the message of a %s without Try again", (_label, error) => {
    const html = renderToStaticMarkup(<ErrorAlert error={error} retry={retry} />);

    expect(html).toContain(error.message);
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("<button");
  });

  it.each([
    [
      "502 try again later",
      new AnalyticsRequestError(
        "Analytics query failed. Please try again later.",
        502,
        "YAVIO-3406",
      ),
    ],
    ["network failure", new TypeError("Failed to fetch")],
  ])("offers Try again for a %s", (_label, error) => {
    const html = renderToStaticMarkup(<ErrorAlert error={error} retry={retry} />);

    expect(html).toContain(error.message);
    expect(html).toContain("Try again");
  });

  it.each([
    ["with YAVIO-3000", new AnalyticsRequestError("Authentication required", 401, "YAVIO-3000")],
    ["without a code", new AnalyticsRequestError("Request failed (HTTP 401)", 401)],
  ])("links a 401 %s to the login page and back", (_label, error) => {
    const html = renderToStaticMarkup(<ErrorAlert error={error} retry={retry} />);

    expect(html).toContain(error.message);
    expect(html).toContain("Sign in again");
    // Back to the same page with the same filters once signed in.
    const back = encodeURIComponent("/w1/p1/funnels?from=2026-01-01&to=2026-10-01");
    expect(html).toContain(`href="/login?callbackUrl=${back}"`);
    expect(html).not.toContain("Try again");
  });

  it("offers no sign-in link for other errors", () => {
    const error = new AnalyticsRequestError(
      "This query needs more memory than the database allows. Narrow the date range or simplify the query.",
      422,
      "YAVIO-3408",
    );

    expect(renderToStaticMarkup(<ErrorAlert error={error} retry={retry} />)).not.toContain(
      "Sign in again",
    );
  });

  it("offers no button without a retry handler", () => {
    const error = new AnalyticsRequestError("Analytics query failed.", 502, "YAVIO-3406");

    expect(renderToStaticMarkup(<ErrorAlert error={error} />)).not.toContain("Try again");
  });
});
