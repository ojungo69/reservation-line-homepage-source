/** Independent work only: preserve result order and settle started work before rejecting. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  // ponytail: four workers bound provider/D1 work; tune only if measured throughput needs it.
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        // Each worker stays sequential to enforce the shared concurrency cap.
        results[index] = await operation(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }));
  if (failed) throw firstError;
  return results;
}
