"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const serviceSource = fs.readFileSync(
  path.join(__dirname, "../js/service.js"),
  "utf8",
);
const contentSource = fs.readFileSync(
  path.join(__dirname, "../js/content.js"),
  "utf8",
);
const popupSource = fs.readFileSync(
  path.join(__dirname, "../js/popup.js"),
  "utf8",
);
const configDefaultsSource = fs.readFileSync(
  path.join(__dirname, "../js/config-defaults.js"),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"),
);

function loadDefaultConfig() {
  const modified = `${configDefaultsSource.replace(
    /export function createDefaultConfig/,
    "function createDefaultConfig",
  )}
module.exports = { createDefaultConfig };
`;
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(modified, sandbox);
  return sandbox.module.exports.createDefaultConfig();
}

// Cookie helpers now live in js/cookies.js as an injectable factory. Load the
// module and build helpers backed by the supplied mock chrome.cookies object.
const { loadEsmModule } = require("./esm-loader.js");
const cookiesModule = loadEsmModule("../js/cookies.js");

function loadCookieHelpers(cookies) {
  const helpers = cookiesModule.createCookieHelpers({
    cookies,
    log: jest.fn(),
    logEnabled: () => false,
  });
  return {
    CLEARED_COOKIE_DOMAINS: cookiesModule.CLEARED_COOKIE_DOMAINS,
    ...helpers,
  };
}

describe("service regressions", () => {
  test("default runtime stores the Rewards counter date", () => {
    const config = loadDefaultConfig();
    expect(config.runtime).toHaveProperty("searchCounterDate", "");
  });

  test("Rewards score reads stay in the service worker", () => {
    expect(serviceSource).toContain("async function fetchRewardsSnapshot()");
    expect(contentSource).not.toContain("rewards.bing.com/api/getuserinfo");
    expect(contentSource).not.toContain("nextConfig.runtime.searchCounterDate");
  });

  test("service worker clears persisted stale sessions on fresh loads", () => {
    expect(serviceSource).toContain(
      'function clearActiveRuntimeState(reason = "stale_runtime")',
    );
    expect(serviceSource).toContain(
      'async function applyStoredConfig(stored, reason = "load")',
    );
    expect(serviceSource).toContain("const hadLiveInMemoryRun = Boolean(");
    expect(serviceSource).toContain(
      'await applyStoredConfig(stored, `message:${message?.action || "unknown"}`);',
    );
  });

  test("popup schedule mode selection does not directly mutate alarms", () => {
    expect(popupSource).not.toContain("armScheduleAlarmForMode");
    expect(popupSource).not.toContain('chrome.alarms.clear("schedule")');
    expect(serviceSource).toContain('await chrome.alarms.clear("schedule");');
  });

  test("popup saves merge into latest config and command responses report real outcomes", () => {
    expect(popupSource).toContain("async function saveConfigMutation(mutator)");
    expect(popupSource).toContain(
      "const updated = await atomicUpdate((stored) => {",
    );
    expect(serviceSource).toContain(
      "const cleared = await clear(false, true);",
    );
    expect(serviceSource).toContain("success: cleared");
    expect(serviceSource).toContain(
      "const simulated = await toggleSimulate();",
    );
    expect(serviceSource).toContain("success: simulated");
  });

  test("6.0 resets stale counters and keeps configured-count plans", () => {
    expect(serviceSource).toContain("function resetStaleSearchCounters()");
    const planBlock = serviceSource.slice(
      serviceSource.indexOf("function limitSearchPlanForToday("),
      serviceSource.indexOf("function hasActivityQuota("),
    );
    expect(planBlock).toContain("return normalizeSearchPlan(searches);");
    expect(planBlock).not.toContain("limitPlanForCompletedCounters");
  });

  test("search query selection keeps per-run template history", () => {
    // Template rotation logic now lives in js/search-plan.js and is covered by
    // real behaviour tests in tests/searchPlan.test.js. Here we only assert the
    // service worker still wires the shared per-run history Set into the picker.
    expect(serviceSource).toContain(
      "let usedSearchQueryTemplates = new Set();",
    );
    expect(serviceSource).toContain("resetSearchQueryHistory();");
    expect(serviceSource).toContain(
      "pickSearchTemplate(niche, queries, usedSearchQueryTemplates)",
    );
    expect(serviceSource).not.toContain(
      "searchQuery = queryList[Math.floor(Math.random() * queryList.length)]",
    );
  });

  test("mobile patch click does not immediately repeat the startup warmup click", () => {
    expect(serviceSource).toContain("let clickedForPatch = false;");
    expect(serviceSource).toContain(
      "clickedForPatch = await click(interruptible);",
    );
    expect(serviceSource).toContain(
      "if (clearIt && i < 3 && !clickedForPatch)",
    );
  });

  test("activity confirmation does not count skips or zero-delta processed tabs as success", () => {
    expect(
      serviceSource.match(
        /const confirmedClick = Number\.isFinite\(pointDelta\)/g,
      ),
    ).toHaveLength(2);
    expect(
      serviceSource.match(/processed: confirmedClick \? processedTabs : 0/g),
    ).toHaveLength(2);
    expect(serviceSource).not.toContain("passResult.skipped > 0 ||");
  });

  test("auth cookie backup reads only cleared Bing/Rewards domains and excludes unrelated cookies", async () => {
    const getAll = jest.fn(({ domain }) =>
      Promise.resolve([
        {
          domain: domain === "bing.com" ? ".bing.com" : "rewards.bing.com",
          path: "/",
          name: `session-${domain}`,
          value: "value",
          secure: true,
        },
        { domain, path: "/", name: "analytics", value: "unrelated" },
      ]),
    );
    const helpers = loadCookieHelpers({ getAll });

    const snapshot = await helpers.backupAuthCookies();

    expect(helpers.CLEARED_COOKIE_DOMAINS).toEqual([
      "bing.com",
      "rewards.bing.com",
    ]);
    expect(getAll.mock.calls.map(([details]) => details.domain)).toEqual([
      "bing.com",
      "rewards.bing.com",
    ]);
    expect(snapshot.map((cookie) => cookie.name)).toEqual([
      "session-bing.com",
      "session-rewards.bing.com",
    ]);
  });

  test("post-search activities respect both runtime stop and session ownership", () => {
    expect(serviceSource).toContain("ownsActivity() && isRuntimeActive()");
    expect(serviceSource).not.toContain("!interruptible || isRuntimeActive()");
  });

  test("manual schedule start persists config before initialise", () => {
    const scheduleCase = serviceSource.slice(
      serviceSource.indexOf("case ACTIONS.SCHEDULE:"),
      serviceSource.indexOf("case ACTIONS.STOP:"),
    );
    const sessionIndex = scheduleCase.indexOf(
      'const scheduleSession = RunCoordinator.startNewSession("schedule")',
    );
    const manualStartBlock = scheduleCase.slice(sessionIndex);
    const setIndex = manualStartBlock.indexOf("await set(config);");
    const initialiseIndex = manualStartBlock.indexOf(
      "await initialise(config?.schedule, scheduleSession.id)",
    );
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeGreaterThan(-1);
    expect(initialiseIndex).toBeGreaterThan(setIndex);
  });

  test("stop handler proactively cleans up keepalive, debugger, and badge", () => {
    expect(serviceSource).toContain("async function handleUserStop()");
    expect(serviceSource).toContain("searchKeepaliveCancel()");
    expect(serviceSource).toContain("await detach(rsaTab, false)");
    expect(serviceSource).toContain("config.runtime.rsaTab = null");
    expect(serviceSource).toContain("await set(config)");
    expect(serviceSource).toContain("case ACTIONS.STOP:");
    expect(serviceSource).toContain("await handleUserStop();");
  });

  test("service worker handles unexpected debugger detach events", () => {
    expect(serviceSource).toContain("chrome.debugger.onDetach.addListener");
  });

  test("initialise passes ended session type into cleanup for schedule re-arm", () => {
    expect(serviceSource).toContain(
      "const endedSessionType = config?.runtime?.currentSession?.type ?? null",
    );
    expect(serviceSource).toContain("endedSessionType,");
  });

  test("wait helpers respect interruptible run stop checks", () => {
    expect(serviceSource).toContain(
      "async function wait(tabId, interruptible = true)",
    );
    expect(serviceSource).toContain("async function waitForUrl(");
    expect(serviceSource).toContain("interruptible = true");
  });

  test("service worker bootstraps config before listeners rely on storage", () => {
    expect(serviceSource).toContain("async function bootstrapConfig()");
    expect(serviceSource).toContain("const configReady = bootstrapConfig();");
    expect(serviceSource).toContain("await configReady;");
    expect(serviceSource).toContain("chrome.runtime.onInstalled.addListener");
    expect(serviceSource).toContain("await bootstrapConfig();");
  });

  test("m2 schedule mode does not auto-start on counter refresh alarms", () => {
    expect(serviceSource).toContain("if (isScheduledModeActive())");
    expect(serviceSource).toContain(
      'await tryStartScheduledRun("ALARM_CLEAR");',
    );
    expect(serviceSource).toContain(
      "m2 runs at startup only, not on timed alarms",
    );
  });

  test("popup stops active runs before runtime or extension reset", () => {
    expect(popupSource).toContain("async function stopActiveRunIfNeeded()");
    // Stop is now sent through the timeout wrapper using the shared ACTIONS enum.
    expect(popupSource).toContain(
      "sendMessageWithTimeout({ action: ACTIONS.STOP })",
    );
    const runtimeHandler = popupSource.slice(
      popupSource.indexOf('$runtime.on("click"'),
      popupSource.indexOf('$reset.on("click"'),
    );
    const resetHandler = popupSource.slice(
      popupSource.indexOf('$reset.on("click"'),
      popupSource.indexOf("chrome.storage.onChanged.addListener"),
    );
    expect(runtimeHandler).toContain("await stopActiveRunIfNeeded();");
    expect(resetHandler).toContain("await stopActiveRunIfNeeded();");
  });

  test("popup paginates Bing history export and deletion", () => {
    expect(popupSource).toContain(
      "async function fetchBingHistoryLast24Hours()",
    );
    expect(popupSource).toContain("endTime: lastVisitTime");
    expect(popupSource).toContain("await fetchBingHistoryLast24Hours()");
  });

  test("popup shows Stop on the trigger owning the active run", () => {
    expect(popupSource).toContain(
      '$scheduleTrigger.text(isScheduleRun ? "Stop" : "Schedule")',
    );
  });

  test("login click reports sign-in initiation instead of logged-in state", () => {
    expect(contentSource).toContain("signInInitiated: true");
    expect(contentSource).not.toContain("loggedIn: true");
  });

  test("applyStoredConfig resets in-memory config when storage is cleared", () => {
    expect(serviceSource).toContain("config = createDefaultConfig();");
    expect(serviceSource).toContain(
      "[CONFIG] Reset in-memory config to defaults (${reason}).",
    );
    expect(serviceSource).toContain("chrome.storage.onChanged.addListener");
    expect(serviceSource).toContain("storage_removed");
  });

  test("stop handler closes RSA tab after detaching debugger", () => {
    const stopBlock = serviceSource.slice(
      serviceSource.indexOf("async function handleUserStop()"),
      serviceSource.indexOf(
        "(async function () {",
        serviceSource.indexOf("async function handleUserStop()"),
      ),
    );
    expect(stopBlock).toContain("await chrome.tabs.remove(rsaTab)");
  });

  test("post-search warmup and activity runs use interruptible delays", () => {
    const searchPhasesSource = fs.readFileSync(
      path.join(__dirname, "../js/search-phases.js"),
      "utf8",
    );
    expect(searchPhasesSource).toContain(
      "await delayFn(activityWarmupDelay, true);",
    );
    expect(searchPhasesSource).toContain(
      "await activityFn(activityTabId, true);",
    );
    expect(searchPhasesSource).not.toContain(
      "await activityFn(activityTabId, false);",
    );
  });

  test("popup waits for worker stop before reset actions", () => {
    const stopFn = popupSource.slice(
      popupSource.indexOf("async function stopActiveRunIfNeeded()"),
      popupSource.indexOf("async function fetchBingHistoryLast24Hours()"),
    );
    // Timeout window is a named constant (STOP_WAIT_TIMEOUT_MS = 15000).
    expect(stopFn).toContain(
      "const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS",
    );
    expect(popupSource).toContain("const STOP_WAIT_TIMEOUT_MS = 15000;");
    expect(stopFn).toContain("return false");
    expect(stopFn).not.toContain("setTimeout(resolve, 150)");
  });

  test("popup aborts runtime reset when stop times out", () => {
    expect(popupSource).toContain("Stop timed out; runtime not reset");
    expect(popupSource).toContain("Stop timed out; extension not reset");
  });

  test("popup handles custom search mode labels", () => {
    expect(popupSource).toContain('config.search.mode = "custom"');
  });

  test("popup paginates history without skipping equal timestamps", () => {
    expect(popupSource).toContain("const excludedIds = new Set()");
    expect(popupSource).toContain("excludedIds.add(item.id)");
  });

  test("popup dedupes paginated Bing history results", () => {
    expect(popupSource).toContain("function dedupeHistoryEntries(entries)");
    expect(popupSource).toContain("return dedupeHistoryEntries(allResults);");
  });

  test("content script does not load unused utils module", () => {
    expect(contentSource).not.toContain(
      'import(chrome.runtime.getURL("js/utils.js"))',
    );
    expect(contentSource).not.toContain("await loadUtils");
  });

  test("auth cookie restore does not overwrite cookies already recreated", async () => {
    const get = jest.fn(({ name }) =>
      Promise.resolve(name === "existing" ? { name, value: "new" } : null),
    );
    const set = jest.fn().mockResolvedValue({});
    const helpers = loadCookieHelpers({ get, set });

    const restored = await helpers.restoreAuthCookies([
      {
        domain: ".bing.com",
        path: "/",
        name: "existing",
        value: "old",
        secure: true,
      },
      {
        domain: ".bing.com",
        path: "/",
        name: "missing",
        value: "old",
        secure: true,
      },
    ]);

    expect(restored).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: "missing",
        value: "old",
      }),
    );
  });

  test("fingerprint patch is scoped to the automation tab through CDP", () => {
    const staticScripts = manifest.content_scripts.flatMap(
      (entry) => entry.js || [],
    );
    expect(staticScripts).not.toContain("/js/fingerprint.js");
    expect(serviceSource).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(serviceSource).toContain("installFingerprintPatch(tabId)");
  });

  test("Daily Set and Claim use trusted CDP mouse presses", () => {
    expect(serviceSource).toContain("async function dispatchTrustedPress");
    expect(serviceSource).toContain('"DAILY SET"');
    expect(serviceSource).toContain('"CLAIM"');
  });

  test("6.0 does not claim to refresh disabled Rewards counters", () => {
    expect(serviceSource).not.toContain("const countersRefreshed = true;");
    expect(serviceSource).toContain("keeping previous counters as unknown.");
  });
});
