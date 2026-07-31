/**
 * Client names are attacker-supplied (DCR body or CIMD document) and end up
 * as the headline of the consent card. Strip everything that could forge or
 * scramble the surrounding UI: control characters, newlines, zero-width and
 * Unicode bidi/formatting overrides; cap the length so the redirect host and
 * the workspace picker can never be pushed out of view.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const DISALLOWED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export function sanitizeClientName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(DISALLOWED, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : null;
}
