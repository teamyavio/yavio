/**
 * How deep a request body may nest: objects and arrays, the body itself
 * counted as the first level. `{ events: [ { metadata: {...} } ] }` uses
 * four levels down to `metadata`, so an event's fields can nest about 60
 * levels; a tool's `input_schema` or `metadata` from our SDKs stays far below.
 *
 * The events route's parsers check it on the raw text, before JSON.parse, and
 * answer a deeper body 400. Everything after them (the size checks, the PII
 * walk, the ClickHouse insert) serializes or walks the parsed body by
 * recursion, so the bound keeps that recursion shallow. The PII walk has its
 * own limit (MAX_PII_WALK_DEPTH) above this one.
 */
export const MAX_BODY_NESTING = 64;

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const OPEN_BRACE = 0x7b; // {
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACE = 0x7d; // }
const CLOSE_BRACKET = 0x5d; // ]

/**
 * Whether JSON `text` opens objects and arrays more than `maxLevels` deep.
 * One pass over the characters: brackets inside strings (escapes included)
 * do not count. It stops at the first bracket past the limit. Malformed text
 * may give any answer; JSON.parse rejects it afterwards either way.
 */
export function exceedsNestingText(text: string, maxLevels: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
      continue;
    }
    if (c === QUOTE) {
      inString = true;
    } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth++;
      if (depth > maxLevels) return true;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      depth--;
    }
  }
  return false;
}
