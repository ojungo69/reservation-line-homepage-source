import { safeCaptureException } from "../sentry-helpers";

export function archiveCsvToR2(
  env: { STORAGE?: R2Bucket },
  stream: ReadableStream,
  storeId: string | undefined,
  dateFrom: string,
  dateTo: string
): { clientStream: ReadableStream; archivePromise: Promise<void> } {
  if (!env.STORAGE) {
    return { clientStream: stream, archivePromise: Promise.resolve() };
  }

  const [clientStream, archiveStream] = stream.tee();
  const key = `csv-exports/${storeId ?? "all"}/${dateFrom}_${dateTo}/${crypto.randomUUID()}.csv`;

  const archivePromise = env.STORAGE.put(key, archiveStream, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" }
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      safeCaptureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: "r2-csv-archive" }
      });
    });

  return { clientStream, archivePromise };
}
