"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

function runWorker(scenario) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-vm-modules",
        "--no-warnings",
        path.join(__dirname, "worker-harness.js"),
        JSON.stringify(scenario),
      ],
      { encoding: "utf8", timeout: 5000 },
    ),
  );
}

describe("real service worker module graph and Chrome event entry points", () => {
  test("mobile navigation patch clears cache without removing cookies or login storage", () => {
    const result = runWorker({ mobilePatchProbe: true });
    expect(result.browsingDataCalls).toHaveLength(1);
    expect(result.browsingDataCalls[0].data).toMatchObject({ cache: true });
    expect(result.browsingDataCalls[0].data).not.toHaveProperty("cookies");
    expect(result.browsingDataCalls[0].data).not.toHaveProperty("localStorage");
  });
  test("ACT diagnostic download includes progress when advanced logs are off", () => {
    const result = runWorker({
      finishEmptyActivity: true,
      messages: [{ action: "activity" }],
    });
    expect(result.config.control.log).toBe(0);
    expect(result.diagnosticDownloads).toHaveLength(1);
    expect(result.diagnosticDownloads[0]).toContain("# version: 6.0.4");
    expect(result.diagnosticDownloads[0]).toContain(
      "Microsoft session: active",
    );
    expect(result.diagnosticDownloads[0]).toContain(
      "Daily set finished scanning",
    );
    expect(result.diagnosticDownloads[0]).toContain(
      "Keep earning finished scanning",
    );
    expect(result.diagnosticDownloads[0]).toContain("Engine finished");
  });
  test("ACT ends and closes its tab when all sections have no runnable cards", () => {
    const result = runWorker({
      finishEmptyActivity: true,
      messages: [{ action: "activity" }],
    });
    expect(result.config.runtime).toMatchObject({
      running: 0,
      act: 0,
      currentSession: null,
      rsaTab: null,
    });
    expect(result.tabsRemoved).toContain(1);
    expect(result.fetchCalls).toBe(2); // account checks only, no score polling on empty scans
    expect(
      result.debuggerCommands.filter(
        (item) => item.command === "Runtime.evaluate",
      ),
    ).toHaveLength(5);
  });
  test.each(["dashboard", "earn", "claim"])(
    "an empty %s scan returns without Rewards polling or post-click waits",
    (activityPassProbe) => {
      const result = runWorker({ activityPassProbe });
      expect(result.fetchCalls).toBe(0);
      expect(result.passResult.clicked).toBeFalsy();
      expect(result.debuggerCommands).toHaveLength(1);
      expect(result.debuggerCommands[0].command).toBe("Runtime.evaluate");
    },
  );
  test("offline Perform reports the error without leaving an active activity session", () => {
    const result = runWorker({
      online: false,
      messages: [{ action: "activity" }],
    });
    expect(result.results[0]).toMatchObject({
      success: false,
      message: expect.stringContaining("offline"),
    });
    expect(result.config.runtime.running).toBe(0);
    expect(result.tabsCreated).toHaveLength(0);
  });
  test("Stop closes a manual activity tab and permits a fresh Start", () => {
    const result = runWorker({
      messages: [
        { action: "activity" },
        { action: "stop" },
        { action: "start" },
      ],
    });
    expect(result.results.map((item) => item.success)).toEqual([
      true,
      true,
      true,
    ]);
    expect(result.tabsRemoved).toContain(1);
    expect(result.config.runtime.mode).toBe("search");
    expect(result.config.runtime.running).toBe(1);
  });

  test("an old activity finishing its wait cannot resume or reset a newer Start", () => {
    const result = runWorker({
      messages: [
        { action: "activity" },
        { action: "stop" },
        { action: "start" },
      ],
      completeTabAfterMessages: 1,
    });
    expect(result.config.runtime).toMatchObject({
      running: 1,
      mode: "search",
      act: 0,
      currentSession: { type: "search" },
    });
    expect(result.config.runtime.lastRunMessage).toBe("Starting searches.");
    expect(result.tabsRemoved).not.toContain(2);
    expect(result.tabsCreated).toHaveLength(2);
  });

  test("a stopped activity cannot attach or click after its pending Rewards response arrives", () => {
    const result = runWorker({
      pauseRewardsSession: true,
      messages: [
        { action: "activity" },
        { action: "stop" },
        { action: "start" },
      ],
    });
    expect(result.config.runtime).toMatchObject({
      running: 1,
      mode: "search",
      act: 0,
      currentSession: { type: "search" },
    });
    expect(result.config.runtime.lastRunMessage).toBe("Starting searches.");
    expect(result.debuggerCommands).toEqual([]);
    expect(result.tabsRemoved).not.toContain(2);
  });
  test.each(["start", "schedule"])(
    "%s creates a Bing tab without Google/Microsoft login",
    (action) => {
      const result = runWorker({ messages: [{ action }] });
      expect(result.results[0].success).toBe(true);
      expect(result.tabsCreated).toEqual([
        expect.objectContaining({ url: "https://www.bing.com/" }),
      ]);
      expect(result.config.runtime.running).toBe(1);
    },
  );

  test("boots with no persisted configuration", () => {
    const result = runWorker({
      config: null,
      messages: [{ action: "start", searches: { desk: 1, mob: 0 } }],
    });
    expect(result.results[0].success).toBe(true);
    expect(result.tabsCreated).toHaveLength(1);
  });

  test.each(["m3", "m4"])(
    "%s schedule starts now and arms its next alarm",
    (mode) => {
      const result = runWorker({ mode, messages: [{ action: "schedule" }] });
      expect(result.results[0].success).toBe(true);
      expect(result.alarms.schedule.when).toBeGreaterThan(Date.now());
      expect(result.tabsCreated).toHaveLength(1);
    },
  );

  test("a schedule alarm wakes the worker and opens Bing", () => {
    const result = runWorker({ mode: "m3", alarm: "schedule" });
    expect(result.tabsCreated).toHaveLength(1);
    expect(result.config.runtime.mode).toBe("schedule");
  });

  test("m2 starts on browser startup", () => {
    const result = runWorker({ mode: "m2", startup: true });
    expect(result.tabsCreated).toHaveLength(1);
    expect(result.config.runtime.mode).toBe("schedule");
  });

  test("m2 does not run on daily refresh alarms", () => {
    const result = runWorker({ mode: "m2", alarm: "clear" });
    expect(result.tabsCreated).toHaveLength(0);
  });

  test("recovers an orphaned run before accepting Start", () => {
    const result = runWorker({
      runtime: {
        running: 1,
        rsaTab: 99,
        currentSession: { id: "old-session", type: "search" },
      },
      messages: [{ action: "start" }],
    });
    expect(result.results[0].success).toBe(true);
    expect(result.tabsRemoved).toContain(99);
    expect(result.tabsCreated).toHaveLength(1);
  });

  test("rejects a second Start without changing the active search plan", () => {
    const result = runWorker({
      messages: [
        { action: "start", searches: { desk: 2, mob: 0 } },
        { action: "start", searches: { desk: 80, mob: 20 } },
      ],
    });
    expect(result.results[1]).toMatchObject({ success: false });
    expect(result.config.search).toMatchObject({ desk: 2, mob: 0 });
    expect(result.tabsCreated).toHaveLength(1);
  });

  test("rejecting Schedule preserves its previous plan and alarms", () => {
    const result = runWorker({
      messages: [
        { action: "start" },
        { action: "schedule", searches: { desk: 80, mob: 20, mode: "m3" } },
      ],
    });
    expect(result.results[1]).toMatchObject({ success: false });
    expect(result.config.schedule).toMatchObject({
      desk: 1,
      mob: 0,
      mode: "m1",
    });
    expect(result.alarms.schedule).toBeUndefined();
  });

  test("offline start cleans up the session and stores an actionable error", () => {
    const result = runWorker({
      online: false,
      messages: [{ action: "start" }],
    });
    expect(result.config.runtime.running).toBe(0);
    expect(result.config.runtime.lastRunMessage).toContain("Chrome is offline");
    expect(result.tabsCreated).toHaveLength(0);
  });

  test("6.0 keeps explicit search counts when daily Rewards counters are complete", () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const result = runWorker({
      runtime: { pcSearch: 1, mobileSearch: 1, searchCounterDate: today },
      messages: [{ action: "start" }],
    });
    expect(result.results[0].success).toBe(true);
    expect(result.config.search.desk).toBe(1);
    expect(result.tabsCreated).toHaveLength(1);
  });
});
