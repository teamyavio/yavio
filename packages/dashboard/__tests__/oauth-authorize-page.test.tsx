import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../lib/oauth/errors";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  resolveClient: vi.fn(),
  checkWorkspaceAccess: vi.fn(),
  createAuthorizationCode: vi.fn(),
  memberships: [] as Array<{ id: string; name: string }>,
}));

/** Stands in for Next's redirect(), which also ends the request by throwing. */
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect to ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("../lib/auth/get-session", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("../lib/auth/workspace-access", () => ({
  checkWorkspaceAccess: mocks.checkWorkspaceAccess,
}));
vi.mock("../lib/oauth/store", () => ({
  createAuthorizationCode: mocks.createAuthorizationCode,
}));
vi.mock("../lib/oauth/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/oauth/clients")>()),
  resolveClient: mocks.resolveClient,
}));
vi.mock("../lib/db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: async () => mocks.memberships,
  };
  return { getDb: () => ({ select: () => chain }) };
});

import { approveConsent, denyConsent } from "../app/(auth)/oauth/authorize/actions";
import AuthorizePage from "../app/(auth)/oauth/authorize/page";

const CLIENT_CALLBACK = "https://client.example/callback";

const CLIENT = {
  clientId: "yvc_0123456789abcdef0123456789abcdef",
  registrationType: "dcr" as const,
  clientName: "Example client",
  redirectUris: [CLIENT_CALLBACK],
};

const VALID = {
  client_id: CLIENT.clientId,
  redirect_uri: CLIENT_CALLBACK,
  response_type: "code",
  state: "opaque-state-123",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  scope: "analytics:read",
  resource: "https://dashboard.test/api/mcp",
};

const INVALID_REQUESTS: Array<[string, Record<string, string | undefined>, string]> = [
  [
    "an unsupported response_type",
    { ...VALID, response_type: "token" },
    "unsupported_response_type",
  ],
  ["no response_type", { ...VALID, response_type: undefined }, "invalid_request"],
  ["no code_challenge", { ...VALID, code_challenge: undefined }, "invalid_request"],
  [
    "an unsupported code_challenge_method",
    { ...VALID, code_challenge_method: "plain" },
    "invalid_request",
  ],
  ["a foreign resource", { ...VALID, resource: "https://other.example/api/mcp" }, "invalid_target"],
];

/** Consent form submissions that do not match a request the user was shown. */
const INVALID_SUBMISSIONS: Array<[string, Record<string, string | undefined>]> = [
  ...INVALID_REQUESTS.map(([label, params]): [string, Record<string, string | undefined>] => [
    label,
    params,
  ]),
  [
    "an unregistered redirect_uri",
    { ...VALID, redirect_uri: "https://elsewhere.example/callback" },
  ],
];

/** The URL the code under test redirected to, or null when it returned normally. */
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
}

async function renderPage(params: Record<string, string | undefined>): Promise<string> {
  const element = await AuthorizePage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

function expectDashboardTarget(target: string | null): void {
  expect(target).not.toBeNull();
  expect(new URL(target as string, "https://dashboard.test").origin).toBe("https://dashboard.test");
}

function formOf(params: Record<string, string | undefined>, workspaceId?: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.append(key, value);
  }
  if (workspaceId !== undefined) form.append("workspace_id", workspaceId);
  return form;
}

describe("authorization page and consent actions", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://dashboard.test");
    vi.stubEnv("APP_URL", "https://dashboard.test");
    mocks.getServerSession.mockResolvedValue({
      userId: "user-1",
      email: "user@example.test",
      name: null,
    });
    mocks.resolveClient.mockResolvedValue(CLIENT);
    mocks.checkWorkspaceAccess.mockResolvedValue({ role: "member", isOwner: false });
    mocks.createAuthorizationCode.mockResolvedValue("yvo_ac_test");
    mocks.memberships = [{ id: "ws-1", name: "Workspace One" }];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("renders the consent page for a valid request", async () => {
    let html = "";
    expect(
      await redirectTarget(async () => {
        html = await renderPage(VALID);
      }),
    ).toBeNull();
    expect(html).toContain("Allow access");
  });

  it.each(INVALID_REQUESTS)(
    "renders an error page instead of redirecting for a request with %s",
    async (_label, params, expectedError) => {
      let html = "";
      expect(
        await redirectTarget(async () => {
          html = await renderPage(params);
        }),
      ).toBeNull();
      expect(html).toContain("Connection request stopped");
      expect(html).toContain(expectedError);
      expect(html).not.toContain("Allow access");
    },
  );

  it("renders an error page for a redirect_uri that is not registered", async () => {
    let html = "";
    expect(
      await redirectTarget(async () => {
        html = await renderPage({ ...VALID, redirect_uri: "https://elsewhere.example/callback" });
      }),
    ).toBeNull();
    expect(html).toContain("Connection request stopped");
    expect(html).not.toContain("elsewhere.example");
  });

  it("sends a signed-out user to the dashboard login page", async () => {
    mocks.getServerSession.mockResolvedValue(null);
    const target = await redirectTarget(() => renderPage(VALID));
    expect(target).toMatch(/^\/login\?callbackUrl=/);
    expect(mocks.resolveClient).not.toHaveBeenCalled();
  });

  it("returns the code to the client after the user allows access", async () => {
    const target = await redirectTarget(() => approveConsent(formOf(VALID, "ws-1")));
    const url = new URL(target as string);
    expect(url.origin + url.pathname).toBe(CLIENT_CALLBACK);
    expect(url.searchParams.get("code")).toBe("yvo_ac_test");
    expect(url.searchParams.get("state")).toBe("opaque-state-123");
    expect(url.searchParams.get("iss")).toBe("https://dashboard.test");
  });

  it("reports access_denied to the client when the chosen workspace is not accessible", async () => {
    mocks.checkWorkspaceAccess.mockResolvedValue(null);
    const target = await redirectTarget(() => approveConsent(formOf(VALID, "ws-other")));
    const url = new URL(target as string);
    expect(url.origin + url.pathname).toBe(CLIENT_CALLBACK);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("iss")).toBe("https://dashboard.test");
    expect(mocks.createAuthorizationCode).not.toHaveBeenCalled();
  });

  it("reports access_denied to the client after the user denies access", async () => {
    const target = await redirectTarget(() => denyConsent(formOf(VALID)));
    const url = new URL(target as string);
    expect(url.origin + url.pathname).toBe(CLIENT_CALLBACK);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("opaque-state-123");
    expect(url.searchParams.get("iss")).toBe("https://dashboard.test");
  });

  it.each(INVALID_SUBMISSIONS)(
    "keeps a submitted request with %s on the dashboard",
    async (_label, params) => {
      for (const action of [approveConsent, denyConsent]) {
        expectDashboardTarget(await redirectTarget(() => action(formOf(params, "ws-1"))));
      }
      expect(mocks.createAuthorizationCode).not.toHaveBeenCalled();
    },
  );

  it("keeps a request from a client that cannot be verified on the dashboard", async () => {
    mocks.resolveClient.mockRejectedValue(
      new OAuthError("invalid_client", "unknown client_id", 401),
    );
    let html = "";
    expect(
      await redirectTarget(async () => {
        html = await renderPage(VALID);
      }),
    ).toBeNull();
    expect(html).toContain("Connection request stopped");
    expect(html).toContain("invalid_client");
    for (const action of [approveConsent, denyConsent]) {
      expectDashboardTarget(await redirectTarget(() => action(formOf(VALID, "ws-1"))));
    }
    expect(mocks.createAuthorizationCode).not.toHaveBeenCalled();
  });
});
