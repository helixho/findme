/** In-memory lookup only; preserve Array.find/Array.filter ordering and duplicates. */
export function firstBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T> {
  const result = new Map<K, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!result.has(key)) result.set(key, row);
  }
  return result;
}

export function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = result.get(key);
    if (group) group.push(row);
    else result.set(key, [row]);
  }
  return result;
}

/** Tuple encoding avoids delimiter collisions, including an absent message identifier. */
export const messageKey = (sessionId: string, messageId: string | undefined) =>
  JSON.stringify([sessionId, messageId]);
