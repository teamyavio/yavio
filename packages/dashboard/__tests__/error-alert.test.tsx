import { ErrorAlert } from "@/components/analytics/error-alert";
import { AnalyticsRequestError } from "@/lib/analytics/request";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

  it("offers no button without a retry handler", () => {
    const error = new AnalyticsRequestError("Analytics query failed.", 502, "YAVIO-3406");

    expect(renderToStaticMarkup(<ErrorAlert error={error} />)).not.toContain("Try again");
  });
});
