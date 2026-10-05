import { describe, it, expect, vi } from "vitest";
import { archiveCsvToR2 } from "../src/storage/r2-helpers";

const mockR2Object = { key: "test-key", size: 100 } as unknown as R2Object;

function createMockBucket(overrides?: Partial<R2Bucket>): R2Bucket {
  return {
    put: vi.fn().mockResolvedValue(mockR2Object),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    delete: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    ...overrides
  } as unknown as R2Bucket;
}

describe("r2-helpers", () => {
  describe("archiveCsvToR2", () => {
    it("returns original stream when STORAGE is undefined", async () => {
      const stream = new ReadableStream();
      const { clientStream, archivePromise } = archiveCsvToR2(
        {},
        stream,
        "store-1",
        "2026-05-01",
        "2026-05-31"
      );
      expect(clientStream).toBe(stream);
      await expect(archivePromise).resolves.toBeUndefined();
    });

    it("tees stream and puts to R2 when STORAGE is present", async () => {
      const bucket = createMockBucket();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("header\n"));
          controller.enqueue(encoder.encode("row1\n"));
          controller.close();
        }
      });

      const { clientStream, archivePromise } = archiveCsvToR2(
        { STORAGE: bucket },
        stream,
        "store-1",
        "2026-05-01",
        "2026-05-31"
      );

      const reader = clientStream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const text = new TextDecoder().decode(
        new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
      );
      expect(text.length).toBeGreaterThan(0);

      await archivePromise;
      expect(bucket.put).toHaveBeenCalledTimes(1);
      const putCall = (bucket.put as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(putCall[0]).toMatch(/^csv-exports\/store-1\/2026-05-01_2026-05-31\//);
      expect(putCall[0]).toMatch(/\.csv$/);
    });

    it("does not include PII in R2 key", async () => {
      const bucket = createMockBucket();
      const stream = new ReadableStream({ start(c) { c.close(); } });
      const { archivePromise } = archiveCsvToR2(
        { STORAGE: bucket },
        stream,
        undefined,
        "2026-01-01",
        "2026-01-31"
      );
      await archivePromise;
      const key = (bucket.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(key).toMatch(/^csv-exports\/all\//);
      expect(key).not.toMatch(/@/);
      expect(key).not.toMatch(/\+81/);
    });

    it("catches R2 put failure without throwing", async () => {
      const bucket = createMockBucket({
        put: vi.fn().mockRejectedValue(new Error("R2 unavailable"))
      });
      const stream = new ReadableStream({ start(c) { c.close(); } });
      const { archivePromise } = archiveCsvToR2(
        { STORAGE: bucket },
        stream,
        "store-1",
        "2026-01-01",
        "2026-01-31"
      );
      await expect(archivePromise).resolves.toBeUndefined();
    });
  });
});
