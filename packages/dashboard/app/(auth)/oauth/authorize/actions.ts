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

/**
 * Reads the LAST value for a field. FormData preserves submission order, and
 * a duplicated field (an injected hidden input ahead of the real control)
 * must not be able to shadow what the user actually chose.
 */
function lastValue(formData: FormData, name: string): string | undefined {
  const values = formData
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && v !== "");
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function authorizeParams(formData: FormData): Record<string, string | undefined> {
  return {
    client_id: lastValue(formData, "client_id"),
    redirect_uri: lastValue(formData, "redirect_uri"),
    response_type: lastValue(formData, "response_type"),
    state: lastValue(formData, "state"),
    code_challenge: lastValue(formData, "code_challenge"),
    code_challenge_method: lastValue(formData, "code_challenge_method"),
    scope: lastValue(formData, "scope"),
    resource: lastValue(formData, "resource"),
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
    if (err instanceof RenderAuthorizeError) {
      // Re-run the authorize page WITH the original parameters so it renders
      // the real reason. Redirecting to a bare /oauth/authorize?error=... put
      // the user on a page that reported "Missing client_id" and offered no
      // way back, while the client was left waiting.
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(authorizeParams(formData))) {
        if (value !== undefined) query.set(key, value);
      }
      redirect(`/oauth/authorize?${query.toString()}`);
    }
    throw err;
  }

  // The workspace picker is the last workspace_id field in the form; taking
  // the last value keeps an injected duplicate from overriding the choice.
  const workspaceId = lastValue(formData, "workspace_id");
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
