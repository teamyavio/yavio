/**
 * How deep a request body may nest: objects and arrays, the body itself
 * counted as the first level. `{ events: [ { metadata: {...} } ] }` uses
 * four levels down to `metadata`, so an event's fields can nest about 60
 * levels; a tool's `input_schema` or `metadata` from our SDKs stays far below.
 *
 * The parsed body is serialized again further on (the batch size check, the
 * per-event size check, the ClickHouse insert), and JSON.stringify recurses,
 * so a body nested deeper than it can handle is refused up front (400).
 * The PII walk has its own limit (MAX_PII_WALK_DEPTH) above this one.
 */
export const MAX_BODY_NESTING = 64;

/**
 * Whether `value` holds objects or arrays nested more than `maxLevels` deep.
 * Iterative, so it answers for any depth, and it stops at the first
 * container past the limit.
 */
export function exceedsNesting(value: unknown, maxLevels: number): boolean {
  if (value === null || typeof value !== "object") return false;
  const stack: Array<[object, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, level] = stack.pop() as [object, number];
    if (level > maxLevels) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (child !== null && typeof child === "object") stack.push([child, level + 1]);
    }
  }
  return false;
}
