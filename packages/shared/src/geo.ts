/**
 * The one region rule (#127, #128). The SDK applies it before a region goes
 * into the `region` field or the reduced `_meta`, and ingest applies it again
 * to whatever a client sends, so the column, the SDK's `_meta` and the
 * dashboard all see the same spelling of the same name.
 */

/** Longest region name kept, in UTF-16 code units after normalisation. */
export const MAX_REGION_LENGTH = 64;

/**
 * What a region name may contain once normalised: letters and combining
 * marks, spaces, and the punctuation real subdivision names use — hyphen,
 * apostrophe, period, comma, parentheses, slash ("Trentino-Alto
 * Adige/Südtirol"), ampersand and the middle dot. No digits, `@` or control
 * characters: a postal code or an email cannot pass as a region, and nothing
 * here can trip a PII pattern later.
 */
const REGION_CHARS = /^[\p{L}\p{M} '.,()/&·-]+$/u;

/**
 * The region name in canonical form, or null.
 *
 * - NFC, so an accent sent decomposed ("u" + U+0308) is the one letter it is;
 * - the typographic apostrophes (U+2018, U+2019) become `'` and the Unicode
 *   dashes (U+2010–U+2015, U+2212) become `-`, so "Côte d’Azur" and
 *   "Côte d'Azur" are one region, not two rows;
 * - runs of space separators become one space, and the ends are trimmed.
 *   A tab or line break is a control character and fails the check.
 *
 * Null when the result is empty, longer than MAX_REGION_LENGTH, has no
 * letter, or has a character outside REGION_CHARS. Nothing is mapped to ISO
 * 3166-2: "State of Berlin" stays "State of Berlin".
 */
export function normalizeRegionName(value: string): string | null {
  // No normalisation shrinks a name this long to 64: skip the work.
  if (value.length > MAX_REGION_LENGTH * 4) return null;
  const name = value
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/\p{Zs}+/gu, " ")
    .replace(/^ | $/g, "");
  if (name.length === 0 || name.length > MAX_REGION_LENGTH) return null;
  return REGION_CHARS.test(name) && /\p{L}/u.test(name) ? name : null;
}
