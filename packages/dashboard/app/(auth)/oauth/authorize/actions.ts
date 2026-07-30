"use server";

import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import {
  RedirectAuthorizeError,
  RenderAuthorizeError,
  errorRedirect,
  successRedirect,
  validateAuthorizeRequest,
} from "@/lib/oauth/authorize";
import { createAuthorizationCode } from "@/lib/oauth/store";
import { redirect } from "next/navigation";

function authorizeParams(formData: FormData): Record<string, string | undefined> {
  const read = (name: string): string | undefined => {
    const value = formData.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    client_id: read("client_id"),
    redirect_uri: read("redirect_uri"),
    response_type: read("response_type"),
    state: read("state"),
    code_challenge: read("code_challenge"),
    code_challenge_method: read("code_challenge_method"),
    scope: read("scope"),
    resource: read("resource"),
  };
}

/**
 * Consent approval. Everything from the form is untrusted and re-validated
 * from scratch — the hidden fields are a transport, not a trust boundary.
 */
export async function approveConsent(formData: FormData): Promise<void> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let request: Awaited<ReturnType<typeof validateAuthorizeRequest>>;
  try {
    request = await validateAuthorizeRequest(authorizeParams(formData));
  } catch (err) {
    if (err instanceof RedirectAuthorizeError) redirect(err.redirectTo);
    if (err instanceof RenderAuthorizeError) redirect("/oauth/authorize?error=invalid_request");
    throw err;
  }

  const workspaceId = formData.get("workspace_id");
  if (typeof workspaceId !== "string" || workspaceId === "") {
    redirect(
      errorRedirect(request.redirectUri, request.state, "access_denied", "no workspace selected"),
    );
  }
  const access = await checkWorkspaceAccess(session.userId, workspaceId);
  if (!access) {
    redirect(
      errorRedirect(
        request.redirectUri,
        request.state,
        "access_denied",
        "not a member of this workspace",
      ),
    );
  }

  const code = await createAuthorizationCode({
    clientId: request.client.clientId,
    userId: session.userId,
    workspaceId,
    redirectUri: request.redirectUri,
    scope: request.scope,
    codeChallenge: request.codeChallenge,
    resource: request.resource,
  });

  redirect(successRedirect(request, code));
}

/** Consent denial: report access_denied to the validated redirect target. */
export async function denyConsent(formData: FormData): Promise<void> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  try {
    const request = await validateAuthorizeRequest(authorizeParams(formData));
    redirect(
      errorRedirect(
        request.redirectUri,
        request.state,
        "access_denied",
        "the user denied the request",
      ),
    );
  } catch (err) {
    if (err instanceof RedirectAuthorizeError) redirect(err.redirectTo);
    if (err instanceof RenderAuthorizeError) redirect("/");
    throw err;
  }
}
