/** Bounded process-local cache. Every reuse is verified; no TTL or mtime trust. */
export class VerifiedSnapshotCache<T> {
  private readonly entries = new Map<string, { value?: T; flight?: Promise<T> }>();
  constructor(private readonly capacity = 2) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("CACHE_CAPACITY_INVALID");
  }
  async get(key: string, load: () => Promise<T>, verify: (value: T) => Promise<void>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {};
      this.entries.set(key, entry);
    }
    if (entry.flight) return entry.flight;
    const selected = entry;
    const flight = (async () => {
      if (selected.value !== undefined) {
        try {
          await verify(selected.value);
          return selected.value;
        } catch {
          // Reload the current pointer, never fall back to stale accepted data.
          selected.value = undefined;
        }
      }
      const value = await load();
      selected.value = value;
      return value;
    })();
    selected.flight = flight;
    try {
      return await flight;
    } catch (error) {
      if (this.entries.get(key) === selected) this.entries.delete(key);
      throw error;
    } finally {
      selected.flight = undefined;
      // Concurrent loads may temporarily exceed capacity; never evict their locks.
      for (const [oldKey, oldEntry] of this.entries) {
        if (this.entries.size <= this.capacity) break;
        if (!oldEntry.flight) this.entries.delete(oldKey);
      }
    }
  }
}
