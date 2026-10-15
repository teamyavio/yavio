/**
 * A Map with a fixed capacity that evicts the least recently used entry.
 *
 * `get` and `set` count as use (a hit is re-inserted at the end of the
 * iteration order); `has` and `peek` do not. Insertion order of a JS Map is
 * the recency order, so eviction is "delete the first key".
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruMap capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        const evicted = this.map.get(oldest.value) as V;
        this.map.delete(oldest.value);
        this.onEvict?.(oldest.value, evicted);
      }
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
