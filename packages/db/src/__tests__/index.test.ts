import { describe, expect, it } from "vitest";

describe("@yavio/db barrel exports", () => {
  it("exports createDb and Database type", async () => {
    // Use dynamic import to avoid side effects from mocked modules
    const mod = await import("../index.js");
    expect(mod.createDb).toBeTypeOf("function");
  });

  it("exports withRLS", async () => {
    const mod = await import("../index.js");
    expect(mod.withRLS).toBeTypeOf("function");
  });

  it("re-exports all schema tables", async () => {
    const mod = await import("../index.js");
    expect(mod.users).toBeDefined();
    expect(mod.workspaces).toBeDefined();
    expect(mod.projects).toBeDefined();
    expect(mod.apiKeys).toBeDefined();
    expect(mod.sessions).toBeDefined();
    expect(mod.oauthAccounts).toBeDefined();
    expect(mod.workspaceMembers).toBeDefined();
    expect(mod.invitations).toBeDefined();
    expect(mod.verificationTokens).toBeDefined();
    expect(mod.loginAttempts).toBeDefined();
    expect(mod.stripeWebhookEvents).toBeDefined();
  });
});
