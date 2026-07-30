import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import https from "node:https";
import net from "node:net";
import { sanitizeClientName } from "./display";
import { OAuthError } from "./errors";

/**
 * CIMD (Client ID Metadata Documents): the client_id IS an https URL serving
 * a JSON metadata document. We fetch it server-side, which makes this an SSRF
 * surface — the fetch must never reach private/internal addresses.
 *
 * The address check runs inside the socket's DNS lookup hook, so the address
 * that is validated is the address that is connected to (no resolve-then-fetch
 * TOCTOU gap). Redirects are not followed at all.
 */

export interface ClientMetadata {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUris: string[];
}

const MAX_DOCUMENT_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const blockList = new net.BlockList();
// IPv4: everything that is not public internet
blockList.addSubnet("0.0.0.0", 8); // "this network"
blockList.addSubnet("10.0.0.0", 8); // RFC 1918
blockList.addSubnet("100.64.0.0", 10); // CGNAT
blockList.addSubnet("127.0.0.0", 8); // loopback
blockList.addSubnet("169.254.0.0", 16); // link-local incl. cloud metadata 169.254.169.254
blockList.addSubnet("172.16.0.0", 12); // RFC 1918
blockList.addSubnet("192.0.0.0", 24); // IETF protocol assignments
blockList.addSubnet("192.168.0.0", 16); // RFC 1918
blockList.addSubnet("198.18.0.0", 15); // benchmarking
blockList.addSubnet("224.0.0.0", 3); // multicast + class E + broadcast
// IPv6
blockList.addSubnet("::", 128, "ipv6"); // unspecified
blockList.addSubnet("::1", 128, "ipv6"); // loopback
blockList.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
blockList.addSubnet("fc00::", 7, "ipv6"); // unique local
blockList.addSubnet("fe80::", 10, "ipv6"); // link-local
// NOTE: deliberately NO ::ffff:0.0.0.0/96 rule. net.BlockList maps IPv4 into
// that range when checking, so listing it blocks EVERY public IPv4 address —
// it rejected claude.ai (160.79.104.10) in the first live test. Mapped
// addresses are still covered: Node normalises ::ffff:127.0.0.1 against the
// IPv4 rules above, which is asserted in the tests.

/** Exported for tests: the address check the DNS hook enforces. */
export function isBlockedAddress(address: string, family: number): boolean {
  return blockList.check(address, family === 6 ? "ipv6" : "ipv4");
}

function assertPublicAddress(address: string, family: number): void {
  if (isBlockedAddress(address, family)) {
    throw new OAuthError("invalid_client", "client_id URL resolves to a non-public address", 400);
  }
}

/**
 * dns.lookup replacement wired into https.request: rejects the connection
 * before it is made if any resolved address is non-public.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, "");
      return;
    }
    const list = addresses as LookupAddress[];
    if (list.length === 0) {
      callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "");
      return;
    }
    for (const entry of list) {
      // An IP literal was already checked pre-connect, but DNS answers are
      // attacker-controlled — every address must pass.
      try {
        assertPublicAddress(entry.address, entry.family);
      } catch (guardError) {
        callback(guardError as NodeJS.ErrnoException, "");
        return;
      }
    }
    if (options.all) {
      callback(null, list);
      return;
    }
    const preferred = options.family === 6 ? list.find((a) => a.family === 6) : undefined;
    const chosen = preferred ?? list[0];
    callback(null, chosen.address, chosen.family);
  });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validates a redirect URI from a metadata document or DCR registration. */
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "https:") return true;
  // RFC 8252 loopback redirects for native clients (Claude Code et al.)
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

export function validateClientIdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "client_id is not a valid URL", 400);
  }
  const devLoopback =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !devLoopback) {
    throw new OAuthError("invalid_client", "client_id URL must use https", 400);
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new OAuthError(
      "invalid_client",
      "client_id URL must not carry credentials or fragment",
      400,
    );
  }
  if (url.port !== "" && !devLoopback) {
    throw new OAuthError("invalid_client", "client_id URL must use the default port", 400);
  }
  if (!devLoopback && net.isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new OAuthError(
      "invalid_client",
      "client_id URL must use a hostname, not an IP literal",
      400,
    );
  }
  return url;
}

function rawFetch(url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "yavio-oauth/1.0" },
        lookup: guardedLookup,
        timeout: FETCH_TIMEOUT_MS,
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            request.destroy();
            reject(new OAuthError("invalid_client", "client metadata document too large", 400));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (err) => reject(err));
    request.end();
  });
}

async function devLoopbackFetch(url: URL): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * Fetch + validate a client metadata document. Every failure maps to
 * invalid_client so spec-following clients fall back to DCR.
 */
export async function fetchClientMetadata(clientId: string): Promise<ClientMetadata> {
  const url = validateClientIdUrl(clientId);
  const devLoopback = url.protocol === "http:";

  let result: { status: number; body: string };
  try {
    result = devLoopback ? await devLoopbackFetch(url) : await rawFetch(url);
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError("invalid_client", "client metadata document could not be fetched", 400);
  }

  // Redirects are deliberately not followed.
  if (result.status !== 200) {
    throw new OAuthError(
      "invalid_client",
      `client metadata document returned HTTP ${result.status}`,
      400,
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(result.body);
  } catch {
    throw new OAuthError("invalid_client", "client metadata document is not valid JSON", 400);
  }
  if (typeof doc !== "object" || doc === null) {
    throw new OAuthError("invalid_client", "client metadata document is not a JSON object", 400);
  }
  const metadata = doc as Record<string, unknown>;

  // The document must claim exactly the URL it was fetched from.
  if (metadata.client_id !== clientId) {
    throw new OAuthError(
      "invalid_client",
      "client_id in metadata document does not match its URL",
      400,
    );
  }

  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u): u is string => typeof u === "string" && isAcceptableRedirectUri(u))
  ) {
    throw new OAuthError(
      "invalid_client",
      "metadata document has no acceptable redirect_uris",
      400,
    );
  }

  // CIMD clients are always public — there is no way to provision a secret.
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    throw new OAuthError(
      "invalid_client",
      "CIMD clients must use token_endpoint_auth_method none",
      400,
    );
  }

  if (redirectUris.length > 10 || redirectUris.some((u) => u.length > 2048)) {
    throw new OAuthError(
      "invalid_client",
      "metadata document has too many or too long redirect_uris",
      400,
    );
  }

  return {
    clientId,
    clientName: sanitizeClientName(metadata.client_name as string | undefined),
    clientUri: typeof metadata.client_uri === "string" ? metadata.client_uri.slice(0, 2048) : null,
    redirectUris,
  };
}
