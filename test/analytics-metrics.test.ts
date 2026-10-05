import { describe, it, expect, vi } from "vitest";
import { trackEvent, type MetricEvent } from "../src/analytics/metrics";

function createMockMetrics() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

describe("analytics/metrics", () => {
  it("retains legacy batch counts and separately reports completed notification jobs", () => {
    const metrics = createMockMetrics();
    trackEvent({ METRICS: metrics }, { type: "notification_sent", storeId: "_batch", environment: "production", channel: "line", jobCount: 10 } as MetricEvent);
    expect(metrics.writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ doubles: [1, 10] }));
  });
  it("writes datapoint with correct schema", () => {
    const metrics = createMockMetrics();
    trackEvent({ METRICS: metrics }, {
      type: "created",
      storeId: "store-1",
      serviceId: "svc-1",
      source: "online",
      environment: "production",
      channel: "line"
    });
    expect(metrics.writeDataPoint).toHaveBeenCalledWith({
      indexes: ["store-1"],
      blobs: ["created", "svc-1", "online", "production", "line"],
      doubles: [1]
    });
  });

  it("uses empty string for optional fields", () => {
    const metrics = createMockMetrics();
    trackEvent({ METRICS: metrics }, {
      type: "approved",
      storeId: "store-2",
      environment: "staging"
    });
    expect(metrics.writeDataPoint).toHaveBeenCalledWith({
      indexes: ["store-2"],
      blobs: ["approved", "", "", "staging", ""],
      doubles: [1]
    });
  });

  it("no-ops when METRICS is undefined", () => {
    expect(() => {
      trackEvent({}, {
        type: "cancelled",
        storeId: "store-1",
        environment: "local"
      });
    }).not.toThrow();
  });

  it("never includes PII in datapoint", () => {
    const metrics = createMockMetrics();
    const event: MetricEvent = {
      type: "created",
      storeId: "store-1",
      serviceId: "svc-1",
      source: "online",
      environment: "production"
    };
    trackEvent({ METRICS: metrics }, event);
    const call = (metrics.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const allValues = [...call.indexes, ...call.blobs].join(" ");
    expect(allValues).not.toMatch(/@/);
    expect(allValues).not.toMatch(/\+81/);
    expect(allValues).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
