import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { oauthClients } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { fetchClientMetadata, isAcceptableRedirectUri } from "./cimd";
import { CIMD_CACHE_TTL_MS, CIMD_STALE_GRACE_MS } from "./constants";
import { sanitizeClientName } from "./display";
import { OAuthError } from "./errors";

export interface OAuthClient {
  clientId: string;
  registrationType: "cimd" | "dcr";
  clientName: string | null;
  redirectUris: string[];
}

function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://") || clientId.startsWith("http://");
}

/**
 * Resolve a client_id to a client. CIMD ids (URLs) are fetched and cached;
 * DCR ids must already exist. 401 invalid_client tells DCR clients to
 * re-register (Claude's documented re-registration signal).
 */
export async function resolveClient(clientId: string): Promise<OAuthClient> {
  const db = getDb();

  if (isCimdClientId(clientId)) {
    const cached = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);

    const fresh =
      cached.length === 1 &&
      cached[0].metadataRefreshedAt !== null &&
      Date.now() - cached[0].metadataRefreshedAt.getTime() < CIMD_CACHE_TTL_MS;

    if (fresh) {
      return {
        clientId,
        registrationType: "cimd",
        clientName: cached[0].clientName,
        redirectUris: cached[0].redirectUris,
      };
    }

    let metadata: Awaited<ReturnType<typeof fetchClientMetadata>>;
    try {
      metadata = await fetchClientMetadata(clientId);
    } catch (err) {
      // Only TRANSPORT failures may fall back to cache. An OAuthError means
      // the document was reachable and rejected — gone, non-200, no longer
      // claiming this client_id, or pointing somewhere non-public. Those are
      // exactly the signals an operator uses to kill a compromised client, so
      // honouring the cache for a week would defeat the kill switch.
      if (err instanceof OAuthError) throw err;
      const staleButUsable =
        cached.length === 1 &&
        cached[0].metadataRefreshedAt !== null &&
        Date.now() - cached[0].metadataRefreshedAt.getTime() < CIMD_STALE_GRACE_MS;
      if (staleButUsable) {
        console.warn(
          `[oauth] CIMD refetch failed for ${clientId}; serving cached metadata from ${cached[0].metadataRefreshedAt?.toISOString()}`,
        );
        return {
          clientId,
          registrationType: "cimd",
          clientName: cached[0].clientName,
          redirectUris: cached[0].redirectUris,
        };
      }
      throw err;
    }

    await db
      .insert(oauthClients)
      .values({
        clientId,
        registrationType: "cimd",
        clientName: metadata.clientName,
        clientUri: metadata.clientUri,
        redirectUris: metadata.redirectUris,
        tokenEndpointAuthMethod: "none",
        metadataRefreshedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: oauthClients.clientId,
        set: {
          clientName: metadata.clientName,
          clientUri: metadata.clientUri,
          redirectUris: metadata.redirectUris,
          metadataRefreshedAt: new Date(),
        },
      });

    return {
      clientId,
      registrationType: "cimd",
      clientName: metadata.clientName,
      redirectUris: metadata.redirectUris,
    };
  }

  const rows = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (rows.length === 0) {
    throw new OAuthError("invalid_client", "unknown client_id", 401);
  }
  return {
    clientId,
    registrationType: "dcr",
    clientName: rows[0].clientName,
    redirectUris: rows[0].redirectUris,
  };
}

/**
 * Cheap "is this client_id known to us" check for the token endpoint: a DB
 * read, never a network fetch. CIMD ids are accepted once they have been
 * cached by an authorization request; a code cannot exist for a client that
 * never reached /oauth/authorize.
 */
export async function requireKnownClient(clientId: string): Promise<void> {
  const rows = await getDb()
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (rows.length === 0) {
    throw new OAuthError("invalid_client", "unknown client_id", 401);
  }
}

/**
 * Exact-match redirect validation, with the RFC 8252 exception: a registered
 * loopback URI (http://localhost/... or http://127.0.0.1/...) matches any
 * port, because native clients bind an ephemeral port per flow.
 */
export function validateRedirectUri(client: OAuthClient, presented: string): void {
  for (const registered of client.redirectUris) {
    if (registered === presented) return;

    let reg: URL;
    let pres: URL;
    try {
      reg = new URL(registered);
      pres = new URL(presented);
    } catch {
      continue;
    }
    const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
    const loopback = reg.protocol === "http:" && loopbackHosts.includes(reg.hostname);
    if (
      loopback &&
      pres.protocol === reg.protocol &&
      pres.hostname === reg.hostname &&
      pres.pathname === reg.pathname &&
      pres.search === reg.search &&
      pres.hash === "" &&
      pres.username === "" &&
      pres.password === ""
    ) {
      return;
    }
  }
  throw new OAuthError("invalid_request", "redirect_uri is not registered for this client", 400);
}

export interface DcrRegistration {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  applicationType: string | null;
}

/** RFC 7591 Dynamic Client Registration — public clients only. */
export async function registerDcrClient(body: Record<string, unknown>): Promise<DcrRegistration> {
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 10 ||
    !redirectUris.every(
      (u): u is string => typeof u === "string" && u.length <= 2048 && isAcceptableRedirectUri(u),
    )
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "redirect_uris must be 1-10 https URLs or http loopback URLs",
      400,
    );
  }

  const clientName = sanitizeClientName(body.client_name as string | undefined);
  const clientUri = typeof body.client_uri === "string" ? body.client_uri.slice(0, 2048) : null;
  // SEP-837: clients now send application_type; accept and record it.
  const applicationType =
    body.application_type === "web" || body.application_type === "native"
      ? body.application_type
      : null;

  const clientId = `yvc_${crypto.randomBytes(16).toString("hex")}`;
  await getDb().insert(oauthClients).values({
    clientId,
    registrationType: "dcr",
    clientName,
    clientUri,
    redirectUris,
    tokenEndpointAuthMethod: "none",
    applicationType,
  });

  return { clientId, clientName, redirectUris, applicationType };
}
