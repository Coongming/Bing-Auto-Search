"use strict";

const { loadEsmModule } = require("./esm-loader.js");

function runtime() {
  return loadEsmModule("../js/activity-runtime.js", {
    AbortController,
    setTimeout,
    clearTimeout,
  });
}

describe("bounded Rewards activity requests", () => {
  afterEach(() => jest.useRealTimers());

  test("aborts and returns when the API never responds", async () => {
    jest.useFakeTimers();
    let signal;
    const request = runtime().readRewardsUserStatus({
      timeoutMs: 8000,
      fetchFn: (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    });
    const check = expect(request).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(8000);
    await check;
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("also bounds a hanging JSON response body", async () => {
    jest.useFakeTimers();
    const request = runtime().readRewardsUserStatus({
      timeoutMs: 8000,
      fetchFn: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    });
    const check = expect(request).rejects.toThrow("timed out");
    await jest.advanceTimersByTimeAsync(8000);
    await check;
  });

  test("returns a valid account response without leaving a timer", async () => {
    jest.useFakeTimers();
    const status = { availablePoints: 42 };
    await expect(
      runtime().readRewardsUserStatus({
        fetchFn: async () => ({
          ok: true,
          json: async () => ({ status: { userStatus: status } }),
        }),
      }),
    ).resolves.toEqual(status);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("activity scans stop when finished or stalled", () => {
  test("two empty scans finish the section even if completed cards are skipped", () => {
    const tracker = runtime().createActivityScanTracker();
    expect(tracker.observe({ clicked: 0, processed: 0, skipped: 3 }).stop).toBe(
      false,
    );
    expect(tracker.observe({ clicked: 0, processed: 0, skipped: 3 }).stop).toBe(
      true,
    );
  });

  test("a repeated retry at the same scroll position cannot reset idle forever", () => {
    const tracker = runtime().createActivityScanTracker();
    expect(tracker.observe({ retry: true, scanPosition: 500 }).stop).toBe(
      false,
    );
    expect(tracker.observe({ retry: true, scanPosition: 500 }).stop).toBe(
      false,
    );
    expect(tracker.observe({ retry: true, scanPosition: 500 }).stop).toBe(true);
  });

  test("scrolling to new cards remains allowed", () => {
    const tracker = runtime().createActivityScanTracker();
    for (let position = 500; position <= 5000; position += 500)
      expect(
        tracker.observe({ retry: true, scanPosition: position }).stop,
      ).toBe(false);
  });

  test("an attempted quiz resets idle without claiming that points were earned", () => {
    const tracker = runtime().createActivityScanTracker();
    tracker.observe({ clicked: 0 });
    expect(
      tracker.observe({ attempted: 1, clicked: 0, pointDelta: 0, retry: true })
        .stop,
    ).toBe(false);
    expect(tracker.observe({ clicked: 0 }).stop).toBe(false);
    expect(tracker.observe({ clicked: 0 }).stop).toBe(true);
  });
});
