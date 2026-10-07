import { queries as queriesBase } from "/js/queries.js";
import { queriesExtra } from "/js/queries_extra.js";
import { queriesV1 } from "/js/queries_v1.js";
// Merge every query source ADDITIVELY per niche group. Spreading the objects
// (`{ ...base, ...extra }`) let a later source's array replace an earlier one
// for any shared key (e.g. "sports", "food"), silently dropping ~450 queries.
// Concatenating keeps them all and folds in the real-world v1 query pool.
const queries = {};
for (const source of [queriesBase, queriesExtra, queriesV1]) {
  for (const [group, list] of Object.entries(source)) {
    if (!Array.isArray(list)) continue;
    queries[group] = (queries[group] || []).concat(list);
  }
}
import {
  log,
  getLogBuffer,
  clearLogBuffer,
  set,
  get,
  resetRuntime,
  applyConfigDefaults,
} from "/js/utils.js";
import {
  getScheduleAlarmDelayMs,
  isScheduledModeActive as isScheduleModeActive,
  armScheduleAlarmForMode,
} from "/js/schedule-utils.js";
import {
  createIsSessionStillActive,
  createRunCoordinator,
} from "/js/run-coordinator.js";
import {
  runSearchPhases,
  handlePostSearchTasks,
  cleanupAfterRun,
} from "/js/search-phases.js";
import { createDefaultConfig } from "/js/config-defaults.js";
import {
  readRewardsUserStatus,
  createActivityScanTracker,
} from "/js/activity-runtime.js";
import { buildRewardsSnapshot, getScoreDelta } from "/js/rewards-metrics.js";
import {
  sanitizeActivityAttempts,
  getBlockedActivityKeys,
  confirmActivityKeys,
  markUnconfirmedActivityKeys,
} from "/js/activity-memory.js";
import {
  DEFAULT_SEARCH_DELAY_MIN as defaultSearchDelayMin,
  DEFAULT_SEARCH_DELAY_MAX as defaultSearchDelayMax,
  MINIMUM_SEARCH_DELAY as minimumSearchDelay,
  normalizeSearchPlan,
  hasSearchWork,
  chooseSearchTemplate as pickSearchTemplate,
} from "/js/search-plan.js";
import { todayKey } from "/js/daily-counters.js";
import { ACTIONS } from "/js/messages.js";
import {
  createDashboardActivityScript,
  createEarnActivityScript,
  createSolveActivityScript,
  createClaimReadyScript,
} from "/js/injected-scripts.js";
import { createCookieHelpers } from "/js/cookies.js";
import { installGlobalCrashHandlers, recordCrash } from "/js/crash-logger.js";

import {
  isRewardActivityUrl as isTrustedRewardActivityUrl,
  isActivityOpenedTab as isTrustedActivityOpenedTab,
} from "/js/activity-tabs.js";
import {
  isConfirmedBingSearchUrl,
  isCompleteSearchCount,
} from "/js/search-results.js";

installGlobalCrashHandlers();

const bing = "https://www.bing.com/";
const rewards = "https://rewards.bing.com/";

const loading = "/loading.html?type=";
const msDomains = [
  "bing.com",
  "microsoft.com",
  "live.com",
  "office.com",
  "outlook.com",
  "msn.com",
  "windows.com",
  "azure.com",
  "xbox.com",
  "skype.com",
  "microsoftonline.com",
  "sharepoint.com",
];
let config = createDefaultConfig();
let logs = config?.control?.log;
// Core run diagnostics are collected even when verbose console logs are off.
function diagnosticLog(message, level = "update") {
  log(message, level, { console: Boolean(logs) });
}
let needPatch = false;
let searchQuery = "";
let usedSearchQueryTemplates = new Set();
let shortestDelay = 1000;
let mediumDelay = 3000;
let longestDelay = 15000;
let searchKeepaliveCancel = null;
const typingDelayMin = 55;
const typingDelayMax = 125;
const preSubmitDelayMin = 700;
const preSubmitDelayMax = 1700;
const betweenSearchDelayMin = 900;
const betweenSearchDelayMax = 1800;
const failedSearchSettleDelayMin = 1200;
const failedSearchSettleDelayMax = 2600;
const finalSearchSettleDelayMax = 8000;
const runtimeDefaults = { ...config.runtime };

// Last cursor position, remembered across clicks so the pointer travels from
// where it "was" rather than teleporting to each target.
let lastMouseX = Math.floor(100 + Math.random() * 600);
let lastMouseY = Math.floor(100 + Math.random() * 400);

// Build a curved, eased sequence of points from (fromX,fromY) to (toX,toY) so
// desktop mouse movement looks human instead of a single instant jump.
function generateMousePath(fromX, fromY, toX, toY, steps = 8) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out: accelerate then decelerate.
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // Slight lateral bow so the path is an arc, not a straight line.
    const curveOffset = Math.sin(t * Math.PI) * (5 + Math.random() * 10);
    const x = fromX + (toX - fromX) * ease + (Math.random() - 0.5) * 2;
    const y = fromY + (toY - fromY) * ease + curveOffset;
    points.push({ x, y });
  }
  return points;
}

// Client Hints (Sec-CH-UA-*) metadata matching the emulated device. Returns
// null for iOS/WebKit, which does not support Client Hints — sending them there
// would contradict the UA string and give the emulation away. Overriding only
// the UA string (without this) leaves the Sec-CH-UA HTTP headers reporting the
// real desktop, an inconsistency Bing can use to reject mobile points.
function getUAMetadata(device) {
  const ua = device?.ua || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return null;

  let platform = "Android";
  let platformVersion = "15.0.0";
  const androidMatch = ua.match(/Android\s+([0-9.]+)/);
  if (androidMatch) {
    platformVersion = androidMatch[1];
  } else if (!/Android/i.test(ua)) {
    // Non-Android, non-iOS UA (unusual for our device list) — treat as desktop.
    platform = "Windows";
  }

  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const edgeMatch = ua.match(/EdgA?\/(\d+)/);
  const version = chromeMatch
    ? chromeMatch[1]
    : edgeMatch
      ? edgeMatch[1]
      : "131";

  const brands = [
    { brand: "Not_A Brand", version: "8" },
    { brand: "Chromium", version },
    edgeMatch
      ? { brand: "Microsoft Edge", version: edgeMatch[1] }
      : { brand: "Google Chrome", version },
  ];

  return {
    brands,
    fullVersion: version + ".0.0.0",
    platform,
    platformVersion,
    architecture: "arm64",
    model: device?.name || "",
    mobile: true,
  };
}

// Build the Network.setUserAgentOverride payload, attaching Client Hints
// metadata when the platform supports it so Sec-CH-UA-* headers stay consistent
// with the spoofed UA string.
function buildUAOverride(device) {
  const payload = { userAgent: device?.ua };
  const metadata = getUAMetadata(device);
  if (metadata) payload.userAgentMetadata = metadata;
  return payload;
}

// Real phones report multiple simultaneous touch points; keep this consistent
// with the emulated platform instead of the desktop-ish default of 1.
function getMaxTouchPoints(device) {
  return /iPhone|iPad|iPod/i.test(device?.ua || "") ? 5 : 10;
}

const activityMemoryKey = "activityMemory";
const maxActivityRunsPerDay = 2;

function isRuntimeActive() {
  return Boolean(config?.runtime?.running || config?.runtime?.act);
}

const { restoreAuthCookiesDetailed } = createCookieHelpers({
  cookies: chrome.cookies,
  log,
  logEnabled: () => logs,
});

// Older 6.0 builds deleted login cookies during mobile searches. Keep recovery
// for snapshots left by those builds; automatic runs now preserve auth storage.
const persistedAuthCookiesKey = "_pendingAuthCookieRestore";

async function clearPersistedAuthCookieSnapshot() {
  try {
    await chrome.storage.local.remove(persistedAuthCookiesKey);
  } catch (error) {
    /* best-effort */
  }
}

async function restorePendingAuthCookies() {
  let snapshot = null;
  try {
    const res = await chrome.storage.local.get(persistedAuthCookiesKey);
    snapshot = res?.[persistedAuthCookiesKey];
  } catch (error) {
    return;
  }
  if (!Array.isArray(snapshot) || !snapshot.length) return;
  let restoreComplete = false;
  try {
    logs &&
      log(
        `[RECOVERY] Restoring ${snapshot.length} auth cookies left over from an interrupted mobile run.`,
        "warning",
      );
    const result = await restoreAuthCookiesDetailed(snapshot);
    restoreComplete = result.complete;
  } catch (error) {
    logs &&
      log(
        `[RECOVERY] Could not restore pending auth cookies: ${error.message}`,
        "warning",
      );
  } finally {
    if (restoreComplete) {
      await clearPersistedAuthCookieSnapshot();
    }
  }
}

function applyConfig(stored) {
  let countersReset = false;
  if (stored) {
    const activeRunKeys = [
      "done",
      "failed",
      "total",
      "rsaTab",
      "running",
      "currentSession",
      "currentPhase",
      "act",
      "mobile",
      "mode",
      "lastRunMessage",
    ];
    const preservedRuntime = {};
    if (config?.runtime?.running) {
      for (const key of activeRunKeys) {
        if (config.runtime[key] !== undefined) {
          preservedRuntime[key] = config.runtime[key];
        }
      }
    }
    applyConfigDefaults(config, stored);
    config.runtime = {
      ...runtimeDefaults,
      ...(stored.runtime || {}),
      ...preservedRuntime,
    };
    countersReset = resetStaleSearchCounters();
  }
  logs = Boolean(config?.control?.log);
  return countersReset;
}

function clearActiveRuntimeState(reason = "stale_runtime") {
  if (!config?.runtime) return false;
  const hadActiveState = Boolean(
    config.runtime.running ||
    config.runtime.currentSession ||
    config.runtime.currentPhase ||
    config.runtime.act ||
    config.runtime.mobile,
  );
  if (!hadActiveState) return false;

  config.runtime.running = 0;
  config.runtime.mode = null;
  config.runtime.currentSession = null;
  config.runtime.currentPhase = null;
  config.runtime.act = 0;
  config.runtime.mobile = 0;
  config.runtime.rsaTab = null;
  logs && log(`[RUNTIME] - Cleared ${reason} active runtime state.`, "warning");
  return true;
}

async function applyStoredConfig(stored, reason = "load") {
  const hadLiveInMemoryRun = Boolean(
    config?.runtime?.running && config?.runtime?.currentSession,
  );
  let countersReset = false;
  if (stored) {
    countersReset = applyConfig(stored);
  } else if (!hadLiveInMemoryRun) {
    config = createDefaultConfig();
    logs = Boolean(config?.control?.log);
    logs &&
      log(`[CONFIG] Reset in-memory config to defaults (${reason}).`, "update");
    return false;
  }
  if (!config?.runtime?.running) {
    if (countersReset) await set(config);
    return false;
  }
  if (hadLiveInMemoryRun) return false;
  // Capture the orphaned automation tab BEFORE clearActiveRuntimeState nulls it,
  // so we can detach its debugger and close it after a worker death.
  const staleTab = Number(config?.runtime?.rsaTab) || null;
  const cleared = clearActiveRuntimeState(`${reason} stale session`);
  if (cleared || countersReset) {
    await set(config);
  }
  if (cleared) {
    await cleanupStaleRun(staleTab);
  }
  return cleared;
}

// Dump the current in-memory log buffer to a file under the browser's Downloads
// folder (Downloads/bingreward-logs/) so a run's full trace can be inspected
// offline. Best-effort: never let a logging failure affect a run. Chrome
// extensions cannot write to arbitrary folders, only into Downloads.
async function flushDiagnosticLog(tag = "run") {
  try {
    const lines = getLogBuffer();
    if (!lines.length) return;
    const header =
      `# Search Auto diagnostic log\n` +
      `# generated: ${new Date().toISOString()}\n` +
      `# version: ${chrome.runtime.getManifest().version}\n` +
      `# tag: ${tag}\n` +
      `# phase: ${config?.runtime?.currentPhase || "idle"} | searches submitted: ${config?.runtime?.done || 0} | failed: ${config?.runtime?.failed || 0}\n` +
      `# device: ${config?.device?.name || "?"} | schedule.mode: ${config?.schedule?.mode || "?"} | act: ${config?.control?.act ? 1 : 0}\n` +
      `# ------------------------------------------------------------\n`;
    const text = header + lines.join("\n") + "\n";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `bingreward-logs/diag-${stamp}-${tag}.log`;
    const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      log(`[DIAG] Wrote diagnostic log: ${filename}`, "update");
    }
    clearLogBuffer();
  } catch (error) {
    log(`[DIAG] Could not write diagnostic log: ${error.message}`, "warning");
  }
}

// Recover from a service worker that died mid-run: restore any login cookies we
// had cleared for the mobile phase, then detach the debugger from and close the
// orphaned automation tab so its "being debugged" banner and mobile emulation
// don't linger.
async function cleanupStaleRun(staleTab) {
  await restorePendingAuthCookies();
  staleTab = Number(staleTab) || null;
  if (staleTab) {
    try {
      await chrome.debugger.detach({ tabId: staleTab });
    } catch (error) {
      /* not attached / already gone */
    }
    try {
      await chrome.tabs.remove(staleTab);
      logs &&
        log(
          `[RECOVERY] Closed orphaned automation tab ${staleTab}.`,
          "warning",
        );
    } catch (error) {
      /* tab already closed */
    }
  }
}

// Alarms are lost when the worker is killed mid-run (the schedule alarm is
// cleared at the start of every run and only re-armed on clean finish). Recreate
// the daily counter-refresh alarms and re-arm the periodic schedule alarm on
// every worker startup if they are missing. All creations are conditional so we
// never reset a pending timer.
async function ensureAlarms() {
  try {
    const nextAtHour = (hour) => {
      const t = new Date();
      t.setHours(hour, 0, 0, 0);
      if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1);
      return t.getTime();
    };
    if (!(await chrome.alarms.get("clear"))) {
      await chrome.alarms.create("clear", {
        when: nextAtHour(6),
        periodInMinutes: 24 * 60,
      });
    }
    if (!(await chrome.alarms.get("clear_afternoon"))) {
      await chrome.alarms.create("clear_afternoon", {
        when: nextAtHour(15),
        periodInMinutes: 24 * 60,
      });
    }
    if (isScheduledModeActive() && !config?.runtime?.running) {
      if (!(await chrome.alarms.get("schedule"))) {
        await armScheduleAlarm(config?.schedule?.mode);
        logs &&
          log(
            `[ALARMS] Re-armed missing schedule alarm after worker restart.`,
            "warning",
          );
      }
    }
  } catch (error) {
    logs &&
      log(`[ALARMS] Could not ensure alarms: ${error.message}`, "warning");
  }
}

function resetStaleSearchCounters() {
  const currentDate = todayKey();
  config.runtime = config.runtime || {};
  if (config.runtime.searchCounterDate === currentDate) return false;
  config.runtime.pcSearch = 0;
  config.runtime.mobileSearch = 0;
  config.runtime.searchCounterDate = currentDate;
  return true;
}

function resetSearchQueryHistory() {
  usedSearchQueryTemplates = new Set();
}

const RunCoordinator = createRunCoordinator({
  getConfig: () => config,
  setConfig: async (newConfig) => {
    config = newConfig;
    await set(config);
  },
  log: diagnosticLog,
});
const isSessionStillActive = createIsSessionStillActive(
  () => config?.runtime?.currentSession,
);

function limitSearchPlanForToday(searches) {
  // Preserve 6.0's configured-count behavior. It does not trim the plan based
  // on Rewards counters; URL confirmation below measures submitted searches.
  return normalizeSearchPlan(searches);
}

function hasActivityQuota() {
  if (!config?.control?.act) return false;
  if (config?.runtime?.activityRunDate !== todayKey()) return true;
  return (
    (Number(config?.runtime?.activityRunsToday) || 0) < maxActivityRunsPerDay
  );
}

function hasActivityWork(options = {}) {
  if (!config?.control?.act) return false;
  if (options.ignoreActivityLimit) return true;
  return hasActivityQuota();
}

function isScheduledModeActive() {
  const mode = (config?.schedule?.mode || "").match(/m[1-4]/)?.[0] || "m1";
  return isScheduleModeActive({ ...config?.schedule, mode });
}

async function armScheduleAlarm(mode = config?.schedule?.mode) {
  const armed = await armScheduleAlarmForMode(mode, (name, opts) =>
    chrome.alarms.create(name, opts),
  );
  if (armed) {
    logs &&
      log(
        `[SCHEDULE] - Next run armed in ~${Math.round(armed / 1000)}s.`,
        "update",
      );
  }
  return Boolean(armed);
}

async function checkRewardsApiSession() {
  try {
    return Boolean(await readRewardsUserStatus());
  } catch {
    return false;
  }
}

async function checkRewardsTabSession(tabId) {
  tabId = Number(tabId);
  if (!tabId) return false;
  try {
    const response = await sendTabMessage(
      tabId,
      { action: "checkRewardsSession" },
      "ACTIVITY",
      { attempts: 2, delayMs: shortestDelay },
    );
    return Boolean(response?.active);
  } catch {
    return false;
  }
}

async function isRewardsSessionActive(tabId = null) {
  if (await checkRewardsApiSession()) return true;
  if (tabId && (await checkRewardsTabSession(tabId))) return true;
  return false;
}

async function refreshSearchCountersFromRewards() {
  // Counter-based daily limits are disabled in 6.0. Account/score checks for
  // activities still run separately; starting searches does not require login.
  return false;
}

async function tryStartScheduledRun(source = "SCHEDULE") {
  if (!isScheduledModeActive() && config?.schedule?.mode !== "m2") {
    return false;
  }

  const limitedPlan = limitSearchPlanForToday(config.schedule, {
    silent: true,
  });
  if (!hasSearchWork(limitedPlan) && !hasActivityWork()) {
    logs &&
      log(`[${source}] - No runnable work remaining for today.`, "update");
    return false;
  }

  const runCheck = RunCoordinator.canStartNewRun();
  if (!runCheck.allowed) {
    logs &&
      log(
        `[${source}] - Skipping scheduled run because another session is active (${runCheck.currentSession?.id}).`,
        "warning",
      );
    return false;
  }

  // Reset query history for fresh session
  resetSearchQueryHistory();

  const session = RunCoordinator.startNewSession("schedule");
  if (!session) return false;

  // Single persistence: counters + session state
  await set(config);
  return initialise(config.schedule, session.id);
}

function chromeStorageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(items);
    });
  });
}

function chromeStorageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function defaultActivityMemory() {
  return {
    date: todayKey(),
    attempts: {},
    lastScore: null,
    runs: 0,
    lastRunAt: "",
  };
}

async function loadActivityMemory() {
  try {
    const items = await chromeStorageGet(activityMemoryKey);
    const memory = items?.[activityMemoryKey] || defaultActivityMemory();
    if (memory.date !== todayKey()) {
      return defaultActivityMemory();
    }
    return {
      date: memory.date,
      attempts: sanitizeActivityAttempts(memory.attempts),
      lastScore: Number.isFinite(memory.lastScore) ? memory.lastScore : null,
      runs: Number(memory.runs) || 0,
      lastRunAt: memory.lastRunAt || "",
    };
  } catch (error) {
    logs &&
      log(
        `[ACTIVITY] Failed to load activity memory: ${error.message}`,
        "warning",
      );
    return defaultActivityMemory();
  }
}

async function saveActivityMemory(memory) {
  try {
    await chromeStorageSet({ [activityMemoryKey]: memory });
  } catch (error) {
    logs &&
      log(
        `[ACTIVITY] Failed to save activity memory: ${error.message}`,
        "warning",
      );
  }
}

async function recordActivityRun(memory = null) {
  const current = memory || (await loadActivityMemory());
  const runAt = new Date().toISOString();
  current.runs = (Number(current.runs) || 0) + 1;
  current.lastRunAt = runAt;
  await saveActivityMemory(current);
  config.runtime.activityRunDate = current.date;
  config.runtime.activityRunsToday = current.runs;
  config.runtime.activityLastRunAt = runAt;
}

async function fetchRewardsSnapshot() {
  try {
    const status = await readRewardsUserStatus();
    return status ? buildRewardsSnapshot(status) : null;
  } catch (error) {
    logs &&
      log(
        `[ACTIVITY] Could not read Rewards score: ${error.message}`,
        "warning",
      );
    return null;
  }
}

// Run generation counter — incremented each new session.
// delay() uses this to avoid killing delays that belong to a new run.
let _runGeneration = 0;
function _bumpRunGeneration() {
  _runGeneration++;
  return _runGeneration;
}
function _getRunGeneration() {
  return _runGeneration;
}

async function delay(ms, interruptible = true) {
  if (ms > 1000) {
    logs &&
      log(
        `[DELAY] Waiting for ${ms}ms... (${
          interruptible ? "interruptible" : "non-interruptible"
        })`,
      );
  }
  if (!interruptible) {
    return new Promise((resolve) =>
      setTimeout(() => {
        resolve();
      }, ms),
    );
  }
  // Capture the run generation at the start of this delay.
  // If a new run starts, _runGeneration changes and we let this delay finish
  // (it belongs to the old run but won't interfere with the new one since
  // the coordinator prevents concurrent runs).
  const startedAtGen = _getRunGeneration();
  if (interruptible && !config?.runtime?.running) {
    logs && log(`[DELAY] Interrupted - not running.`, "warning");
    return false;
  }
  const checkInterval = 100;
  let resolved = false;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const intervalId = setInterval(() => {
      // Only interrupt if both: run stopped AND no new run has started
      if (
        !config?.runtime?.running &&
        _getRunGeneration() === startedAtGen &&
        !resolved
      ) {
        resolved = true;
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        if (ms > 1000) {
          logs &&
            log(
              `[DELAY] Interrupted in ${Date.now() - startTime}ms.`,
              "warning",
            );
        }
        resolve();
      }
    }, checkInterval);
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearInterval(intervalId);
      }
      resolve();
    }, ms);
  });
}

async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || false;
  } catch (err) {
    log(
      `[GET TAB URL] Error fetching URL for tab ${tabId}: ${err.message}`,
      "error",
    );
    return false;
  }
}

async function sendTabMessage(
  tabId,
  message,
  context = "TAB MESSAGE",
  options = {},
) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const delayMs = Math.max(0, Number(options.delayMs) || shortestDelay);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      logs &&
        log(
          `[${context}] Could not send message to tab ${tabId} (attempt ${attempt}/${attempts}): ${error.message}`,
          "warning",
        );
      if (attempt < attempts) {
        await delay(delayMs, false);
      }
    }
  }

  logs &&
    log(
      `[${context}] Giving up sending message to tab ${tabId}: ${lastError?.message || "unknown error"}`,
      "error",
    );
  return null;
}

async function wait(tabId, interruptible = true) {
  logs && log(`[WAIT] Waiting for tab ${tabId} to load...`);
  const startTime = Date.now();
  const startedAtGen = _getRunGeneration();
  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    let interruptTimer = null;

    const done = (success, message = `Tab ${tabId} loaded successfully.`) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(interruptTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      logs &&
        log(
          `[WAIT] ${message} (Took ${Date.now() - startTime}ms) - ${
            success ? "Success" : "Failed"
          }`,
        );
      resolve(success);
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") done(true);
    };
    timer = setTimeout(() => {
      done(false, `Tab ${tabId} did not load within the timeout period.`);
    }, longestDelay);

    if (interruptible) {
      interruptTimer = setInterval(() => {
        if (
          !config?.runtime?.running &&
          _getRunGeneration() === startedAtGen &&
          !resolved
        ) {
          done(false, `Tab ${tabId} wait interrupted because run stopped.`);
        }
      }, 100);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          done(true);
        }
      })
      .catch((error) => {
        log(`[WAIT] Error getting tab ${tabId}: ${error.message}`, "error");
        done(false, `Error getting tab ${tabId}: ${error.message}`);
      });
  });
}

async function clear(interruptible = true, clearCookies = false) {
  if (interruptible && !config?.runtime?.running) {
    diagnosticLog("[CLEAR] Interrupted, skipping clear.", "warning");
    return false;
  }
  const tabId = config?.runtime?.rsaTab;
  const originalUrl = await getTabUrl(tabId);
  if (tabId && originalUrl) {
    await chrome.tabs.update(tabId, {
      url: loading + "clear",
    });
    await wait(tabId);
    await delay(shortestDelay, interruptible);
    diagnosticLog(
      `[CLEAR] Tab updated to loading page: ${loading}clear`,
      "update",
    );
  }

  try {
    const dataToRemove = {
      cache: true,
      cacheStorage: true,
      serviceWorkers: true,
      pluginData: true,
    };
    if (clearCookies) {
      dataToRemove.cookies = true;
      dataToRemove.localStorage = true;
    }

    const origins = clearCookies ? [bing, rewards] : [bing];
    await chrome.browsingData.remove(
      {
        origins,
        since: 0,
      },
      dataToRemove,
    );
    await delay(shortestDelay, interruptible);
    diagnosticLog(
      `[CLEAR] Browsing data cleared (${clearCookies ? "including" : "preserving"} auth storage).`,
      "success",
    );
  } catch (error) {
    log(`[CLEAR] Error clearing browsing data: ${error.message}`, "error");
    return false;
  }

  if (tabId && originalUrl) {
    await chrome.tabs.update(tabId, {
      url: originalUrl,
    });
    await wait(tabId);
    diagnosticLog(
      `[CLEAR] Tab updated to original URL: ${originalUrl}`,
      "update",
    );
  }
  return true;
}

function startSearchKeepalive(tabId) {
  let cancelled = false;
  let failures = 0;
  const loop = async () => {
    while (!cancelled && config?.runtime?.running) {
      try {
        await chrome.tabs.sendMessage(tabId, { action: "ping" });
        failures = 0;
      } catch (error) {
        failures++;
        if (failures >= 3) {
          logs &&
            log(
              `[SEARCH] Content script unreachable after ${failures} ping failures.`,
              "warning",
            );
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, longestDelay));
    }
  };
  loop().catch((err) => {
    logs && log(`[SEARCH] Keepalive loop crashed: ${err?.message}`, "error");
  });
  return () => {
    cancelled = true;
  };
}

async function bootstrapConfig() {
  try {
    const stored = await get();
    await applyStoredConfig(stored, "bootstrap");
    await ensureAlarms();
    logs && log("[BOOTSTRAP] - Config loaded.", "update");
  } catch (error) {
    log(`[BOOTSTRAP] - Error loading config: ${error.message}`, "error");
  }
}

const configReady = bootstrapConfig();

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = Number(source?.tabId);
  if (!tabId) return;
  logs &&
    log(
      `[DEBUGGER] Detached from tab ${tabId}: ${reason || "unknown"}`,
      "warning",
    );
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.config) return;
  const stored = changes.config.newValue ?? null;
  await applyStoredConfig(
    stored,
    stored ? "storage_changed" : "storage_removed",
  );
});

async function handleUserStop() {
  if (searchKeepaliveCancel) {
    searchKeepaliveCancel();
    searchKeepaliveCancel = null;
  }
  const rsaTab = Number(config?.runtime?.rsaTab);
  await RunCoordinator.stopCurrentSession("user_requested");
  if (rsaTab) {
    await detach(rsaTab, false).catch(() => {});
    try {
      await chrome.tabs.remove(rsaTab);
    } catch (error) {
      logs &&
        log(`[STOP] Could not close RSA tab: ${error.message}`, "warning");
    }
  }
  // A new run may start while the old tab is being detached/closed. Its
  // runtime and badge belong to that new session, not this Stop completion.
  if (config.runtime.running || config.runtime.currentSession) return;
  config.runtime.rsaTab = null;
  config.runtime.mobile = 0;
  config.runtime.act = 0;
  config.runtime.currentPhase = null;
  config.runtime.lastRunMessage = "Run stopped.";
  await set(config);
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch (error) {
    logs && log(`[STOP] Could not clear badge: ${error.message}`, "warning");
  }
}

// Registered synchronously at top level (MV3 requirement) so the listener is
// reinstated whenever the worker respawns and can wake it on navigation. The
// handler no-ops until config is ready thanks to optional chaining.
const handleMsNavigation = ({ tabId, url }) => {
  tabId = Number(tabId);
  if (tabId === config?.runtime?.rsaTab) return;
  if (
    url &&
    msDomains.some((domain) => url.includes(domain)) &&
    config?.runtime?.running &&
    config?.runtime?.mobile &&
    config?.control?.clear &&
    !config?.runtime?.act
  ) {
    needPatch = true;
    logs &&
      log(
        `[WATCHER] - (Patch Required) MS domain navigation detected in tab ${tabId}: ${url}`,
        "warning",
      );
  }
};
chrome.webNavigation.onCommitted.addListener(handleMsNavigation);

async function isDebuggerAttached(tabId) {
  tabId = Number(tabId);
  logs &&
    log(`[DEBUGGER CHECK] Checking if debugger is attached to tab ${tabId}...`);
  try {
    const targets = await chrome.debugger.getTargets();
    return targets.some(
      (target) =>
        target.type === "page" && target.tabId === tabId && target.attached,
    );
  } catch (error) {
    log(
      `[DEBUGGER CHECK] Error checking debugger status: ${error.message}`,
      "error",
    );
    return false;
  }
}

async function race(promise, ms, errorMsg = "Operation timed out") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    promise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let fingerprintSourcePromise = null;
const fingerprintPatchedTabs = new Set();

async function installFingerprintPatch(tabId) {
  tabId = Number(tabId);
  if (!tabId || fingerprintPatchedTabs.has(tabId)) return true;
  try {
    fingerprintSourcePromise ||= fetch(
      chrome.runtime.getURL("/js/fingerprint.js"),
    ).then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load fingerprint patch: ${response.status}`);
      }
      return response.text();
    });
    const source = await fingerprintSourcePromise;
    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
      ),
      longestDelay,
      "Timed out registering fingerprint patch.",
    );
    await race(
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: source,
      }),
      longestDelay,
      "Timed out applying fingerprint patch.",
    );
    fingerprintPatchedTabs.add(tabId);
    return true;
  } catch (error) {
    logs &&
      log(
        `[FINGERPRINT] Could not patch automation tab ${tabId}: ${error.message}`,
        "warning",
      );
    return false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  fingerprintPatchedTabs.delete(Number(tabId));
});

async function attach(tabId, interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    logs &&
      log(`[ATTACH] Interrupted, skipping attach to tab ${tabId}.`, "warning");
    return false;
  }
  tabId = Number(tabId);
  const isAttached = await isDebuggerAttached(tabId);
  if (isAttached) {
    logs &&
      log(`[ATTACH] - Debugger already attached to tab ${tabId}.`, "update");
    return true;
  }
  const originalUrl = await getTabUrl(tabId);
  logs && log(`[ATTACH] - Attaching debugger to tab ${tabId}...`, "update");

  if (!tabId || !originalUrl) {
    log(`[ATTACH] - Invalid tabId or URL. Skipping...`, "warning");
    return false;
  }

  try {
    await race(
      chrome.debugger.attach({ tabId }, "1.3").catch((err) => {
        if (err.message?.includes("Another debugger")) {
          log(`[ATTACH] - Another debugger is already attached.`, "warning");
        }
        throw err;
      }),
      longestDelay,
    );
    logs && log(`[ATTACH] - Debugger attached to tab ${tabId}.`, "success");
    await delay(shortestDelay, interruptible);

    await race(
      chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }),
      longestDelay,
    );
    logs && log(`[ATTACH] - Auto-attach set for tab ${tabId}.`, "success");
    await delay(shortestDelay, interruptible);
  } catch (error) {
    log(`[ATTACH] - Error attaching debugger: ${error.message}`, "error");
    return false;
  }

  return true;
}

async function simulate(tabId, interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    diagnosticLog(
      `[SIMULATE] Interrupted, skipping simulate for tab ${tabId}.`,
      "warning",
    );
    return false;
  }
  tabId = Number(tabId);
  const originalUrl = await getTabUrl(tabId);
  diagnosticLog(`[SIMULATE] - Simulating tab ${tabId}...`, "update");

  if (!tabId || !originalUrl) {
    log(`[SIMULATE] - Invalid tabId or URL. Skipping...`, "warning");
    return false;
  }

  let attached = await isDebuggerAttached(tabId);
  if (!attached) {
    attached = await attach(tabId, interruptible);
    if (!attached) return false;
    await delay(shortestDelay, interruptible);
    diagnosticLog(`[SIMULATE] - Debugger attached to tab ${tabId}.`, "success");
  }
  await installFingerprintPatch(tabId);

  if (tabId && originalUrl) {
    await chrome.tabs.update(tabId, {
      url: loading + "simulate",
    });
    await wait(tabId);
    diagnosticLog(
      `[SIMULATE] - Tab updated to loading page: ${loading}simulate`,
      "update",
    );
    await delay(shortestDelay, interruptible);
  }

  try {
    const stillAttached = await isDebuggerAttached(tabId);
    if (!stillAttached) {
      diagnosticLog(
        `[SIMULATE] - Debugger not attached before emulation commands. Re-attaching...`,
        "warning",
      );
      await attach(tabId, interruptible);
    }

    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.clearDeviceMetricsOverride",
      ),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - Device metrics cleared for tab ${tabId}.`,
      "success",
    );

    const deviceMetrics = {
      mobile: true,
      fitWindow: true,
      width: config.device.w,
      height: config.device.h,
      deviceScaleFactor: config.device.scale,
    };

    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setDeviceMetricsOverride",
        deviceMetrics,
      ),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - Device metrics set for tab ${tabId}: ${JSON.stringify(
        deviceMetrics,
      )}`,
      "success",
    );

    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Network.setUserAgentOverride",
        buildUAOverride(config?.device),
      ),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - User agent overridden for tab ${tabId}: ${config?.device?.ua}`,
      "success",
    );

    await race(
      chrome.debugger.sendCommand({ tabId }, "Network.setBypassServiceWorker", {
        bypass: true,
      }),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - Bypass service worker enabled for tab ${tabId}.`,
      "success",
    );

    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: true,
          maxTouchPoints: getMaxTouchPoints(config?.device),
          configuration: "mobile",
        },
      ),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - Touch emulation enabled for tab ${tabId}.`,
      "success",
    );

    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setEmitTouchEventsForMouse",
        {
          enabled: true,
          configuration: "mobile",
        },
      ),
      shortestDelay,
    );
    diagnosticLog(
      `[SIMULATE] - Mouse events set for touch for tab ${tabId}.`,
      "success",
    );
    await delay(shortestDelay, interruptible);
    diagnosticLog(
      `[SIMULATE] - Done for ${tabId} using device ${config.device.name}`,
      "update",
    );
  } catch (error) {
    log(`[SIMULATE] - Error simulating tab: ${error.message}`, "error");
    await detach(tabId).catch(() => {});
    return false;
  }

  if (tabId && originalUrl) {
    await chrome.tabs.update(tabId, {
      url: originalUrl,
    });
    await wait(tabId);
    diagnosticLog(
      `[SIMULATE] Tab updated to original URL: ${originalUrl}`,
      "update",
    );
    await delay(shortestDelay, interruptible);

    try {
      const deviceMetrics = {
        mobile: true,
        fitWindow: true,
        width: config.device.w,
        height: config.device.h,
        deviceScaleFactor: config.device.scale,
      };
      await race(
        chrome.debugger.sendCommand(
          { tabId },
          "Emulation.setDeviceMetricsOverride",
          deviceMetrics,
        ),
        shortestDelay,
      );
      await race(
        chrome.debugger.sendCommand(
          { tabId },
          "Network.setUserAgentOverride",
          buildUAOverride(config?.device),
        ),
        shortestDelay,
      );
      diagnosticLog(
        `[SIMULATE] - Re-applied emulation after navigation for tab ${tabId}.`,
        "success",
      );
    } catch (error) {
      log(
        `[SIMULATE] - Error re-applying emulation after navigation: ${error.message}`,
        "error",
      );
    }
  }
  return true;
}

async function detach(tabId, interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    logs &&
      log(`[DETACH] Interrupted, skipping detach for tab ${tabId}.`, "warning");
    return false;
  }
  tabId = Number(tabId);
  const originalUrl = await getTabUrl(tabId);

  if (!tabId || !originalUrl) {
    log(`[DETACH] - Invalid tabId or URL. Skipping...`, "warning");
    return false;
  }

  const attached = await isDebuggerAttached(tabId);
  if (!attached) {
    logs &&
      log(
        `[DETACH] - Debugger not attached to tab ${tabId}, skipping detach.`,
        "update",
      );
    return true;
  }

  logs && log(`[DETACH] - Detaching debugger from tab ${tabId}...`, "update");

  const resetCommands = [
    ["Emulation.clearDeviceMetricsOverride", {}],
    ["Network.setUserAgentOverride", { userAgent: "" }],
    ["Network.setBypassServiceWorker", { bypass: false }],
    ["Emulation.setTouchEmulationEnabled", { enabled: false }],
    ["Emulation.setEmitTouchEventsForMouse", { enabled: false }],
  ];
  for (const [command, params] of resetCommands) {
    try {
      await race(
        chrome.debugger.sendCommand({ tabId }, command, params),
        shortestDelay,
      );
      logs &&
        log(
          `[DETACH] - Reset command sent: ${command} with params: ${JSON.stringify(
            params,
          )}`,
          "success",
        );
    } catch (error) {
      logs &&
        log(
          `[DETACH] - Error sending reset command ${command}: ${error.message}`,
          "error",
        );
      continue;
    }
  }
  await delay(shortestDelay, interruptible);
  try {
    await race(
      chrome.debugger.detach({ tabId }),
      mediumDelay,
      `Failed to detach debugger from tab ${tabId} within timeout.`,
    );
    logs && log(`[DETACH] - Debugger detached from tab ${tabId}.`, "success");
  } catch (error) {
    log(`[DETACH] - Error detaching tab: ${error.message}`, "error");
    return false;
  }

  return true;
}

async function toggleSimulate() {
  try {
    const currentTab = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tab = currentTab?.[0];
    const tabId = tab?.id;
    if (!tabId) {
      logs && log("[TOGGLE SIMULATE] No active tab found.", "error");
      return false;
    }
    const isAttached = await isDebuggerAttached(tabId);
    if (!isAttached) {
      // Only ever attach the debugger to a Bing page — never to whatever
      // unrelated site (bank, email, …) the user happens to have focused.
      if (!/:\/\/([^/]*\.)?bing\.com\//i.test(tab?.url || "")) {
        logs &&
          log(
            "[TOGGLE SIMULATE] Active tab is not a Bing page; refusing to attach debugger.",
            "warning",
          );
        return false;
      }
      await attach(tabId, false);
      await delay(shortestDelay, false);
      await simulate(tabId, false);
      logs &&
        log(
          `[TOGGLE SIMULATE] Debugger attached and simulated for tab ${tabId}.`,
          "success",
        );
      return true;
    } else {
      await detach(tabId, false);
      await delay(shortestDelay, false);
      logs &&
        log(
          `[TOGGLE SIMULATE] Debugger detached from tab ${tabId}.`,
          "success",
        );
      return true;
    }
  } catch (error) {
    log(`[TOGGLE SIMULATE] Error toggling simulate: ${error.message}`, "error");
    return false;
  }
}

async function ensureEmulation(tabId) {
  if (!config?.runtime?.mobile) return true;
  tabId = Number(tabId);
  try {
    const isAttached = await isDebuggerAttached(tabId);
    if (!isAttached) {
      logs &&
        log(
          `[EMULATION] Debugger not attached to tab ${tabId}. Attaching...`,
          "update",
        );
      await attach(tabId, false);
      await delay(shortestDelay, false);
    }
    const deviceMetrics = {
      mobile: true,
      fitWindow: true,
      width: config.device.w,
      height: config.device.h,
      deviceScaleFactor: config.device.scale,
    };
    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setDeviceMetricsOverride",
        deviceMetrics,
      ),
      shortestDelay,
    );
    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Network.setUserAgentOverride",
        buildUAOverride(config?.device),
      ),
      shortestDelay,
    );
    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: true,
          maxTouchPoints: getMaxTouchPoints(config?.device),
          configuration: "mobile",
        },
      ),
      shortestDelay,
    );
    await race(
      chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setEmitTouchEventsForMouse",
        { enabled: true, configuration: "mobile" },
      ),
      shortestDelay,
    );
    logs &&
      log(
        `[EMULATION] - Mobile emulation verified/applied for tab ${tabId}.`,
        "success",
      );
    return true;
  } catch (error) {
    log(
      `[EMULATION] - Error ensuring emulation for tab ${tabId}: ${error.message}`,
      "error",
    );
    return false;
  }
}

async function enableDomains(tabId) {
  tabId = Number(tabId);
  try {
    const domains = ["Page", "Runtime", "DOM"];
    for (const domain of domains) {
      await race(
        chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {}),
        shortestDelay,
        `Failed to enable ${domain} domain for tab ${tabId} within timeout.`,
      );
    }
    logs &&
      log(`[ENABLE DOMAINS] - Enabled domains for tab ${tabId}.`, "success");
    await delay(shortestDelay, true);
    return true;
  } catch (error) {
    log(
      `[ENABLE DOMAINS] - Error enabling domains for tab ${tabId}: ${error.message}`,
      "error",
    );
    return false;
  }
}

async function click(interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    logs && log("[CLICK] Interrupted, skipping click operation.", "warning");
    return false;
  }

  const tabId = Number(config?.runtime?.rsaTab);
  if (!tabId) {
    logs &&
      log("[CLICK] No RSA tab found, skipping click operation.", "warning");
    return false;
  }
  if (!(await ensureEmulation(tabId))) {
    logs &&
      log("[CLICK] Mobile emulation is not ready; skipping click.", "warning");
    return false;
  }

  let success = false;
  try {
    await enableDomains(tabId);
    const selector = config?.runtime?.mobile ? "#mHamburger" : ".b_clickarea";

    const { root: documentNode } = await race(
      chrome.debugger.sendCommand({ tabId }, "DOM.getDocument"),
      shortestDelay,
      `Failed to get document for tab ${tabId} within timeout.`,
    );

    if (!documentNode || !documentNode.nodeId) {
      logs &&
        log(`[CLICK] - Failed to get document node for tab ${tabId}.`, "error");
      return false;
    }

    const { nodeId } = await race(
      chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
        nodeId: documentNode.nodeId,
        selector: selector,
      }),
      shortestDelay,
      `Failed to query selector "${selector}" for tab ${tabId} within timeout.`,
    );
    if (!nodeId) {
      logs &&
        log(
          `[CLICK] - Failed to get node ID for selector "${selector}" in tab ${tabId}.`,
          "error",
        );
      return false;
    }

    await race(
      chrome.debugger.sendCommand({ tabId }, "DOM.scrollIntoViewIfNeeded", {
        nodeId: nodeId,
      }),
      shortestDelay,
      `Failed to scroll into view for node ID ${nodeId} in tab ${tabId} within timeout.`,
    );
    await delay(shortestDelay, interruptible);

    const { model } = await race(
      chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", {
        nodeId: nodeId,
      }),
      shortestDelay,
      `Failed to get box model for node ID ${nodeId} in tab ${tabId} within timeout.`,
    );
    if (!model) {
      logs &&
        log(
          `[CLICK] - Invalid box model for node ID ${nodeId} in tab ${tabId}.`,
          "error",
        );
      return false;
    }

    const quad = model?.content;
    const x = (quad[0] + quad[2]) / 2;
    const y = (quad[1] + quad[5]) / 2;
    logs &&
      log(
        `[CLICK] - Click coordinates for tab ${tabId}: (${x}, ${y})`,
        "update",
      );

    if (config?.runtime?.mobile) {
      await race(
        chrome.debugger.sendCommand({ tabId }, "Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            {
              x,
              y,
              radiusX: 5,
              radiusY: 5,
              force: 0.5,
            },
          ],
        }),
        shortestDelay,
        `Failed to dispatch touch event for tab ${tabId} within timeout.`,
      );
    } else {
      // Move the cursor toward the target along a human-like curved path,
      // emitting several intermediate mouseMoved events, before pressing.
      const path = generateMousePath(lastMouseX, lastMouseY, x, y);
      for (const point of path) {
        await race(
          chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
          }),
          shortestDelay,
        ).catch(() => {}); // ignore transient path errors, keep moving
        await delay(8 + Math.random() * 12, interruptible);
      }
      lastMouseX = x;
      lastMouseY = y;
      await delay(80 + Math.random() * 120, interruptible);
      await race(
        chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          x,
          y,
          clickCount: 1,
        }),
        shortestDelay,
        `Failed to dispatch mouse event for tab ${tabId} within timeout.`,
      );
    }
    await delay(80 + Math.random() * 120, interruptible);
    if (config?.runtime?.mobile) {
      await race(
        chrome.debugger.sendCommand({ tabId }, "Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        }),
        shortestDelay,
        `Failed to dispatch touch event for tab ${tabId} within timeout.`,
      );
    } else {
      await race(
        chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          x,
          y,
          clickCount: 1,
        }),
        shortestDelay,
        `Failed to dispatch mouse event for tab ${tabId} within timeout.`,
      );
    }
    logs &&
      log(`[CLICK] - Click operation completed for tab ${tabId}.`, "success");
    await delay(shortestDelay, interruptible);
    success = true;
  } catch (error) {
    log(`[CLICK] - Error during click operation: ${error.message}`, "error");
  }

  // Fallback login only runs when debugger click didn't succeed
  if (!success) {
    logs &&
      log(
        `[CLICK] - Applying fallback method for login for tab ${tabId}.`,
        "update",
      );
    await sendTabMessage(
      tabId,
      {
        action: "login",
        mobile: config?.runtime?.mobile,
      },
      "CLICK",
    );
    await delay(shortestDelay, interruptible);
  }
  if (needPatch) {
    needPatch = false;
  }
  return success;
}

async function query(interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    logs && log("[QUERY] Interrupted, skipping query operation.", "warning");
    return false;
  }
  const tabId = Number(config?.runtime?.rsaTab);
  if (!tabId) {
    logs &&
      log("[QUERY] No RSA tab found, skipping query operation.", "warning");
    return false;
  }
  if (!(await ensureEmulation(tabId))) {
    logs &&
      log("[QUERY] Mobile emulation is not ready; skipping query.", "warning");
    return false;
  }
  logs &&
    log(`[QUERY] - Starting query operation for tab ${tabId}...`, "update");
  let niche = config?.control?.niche || "random";
  const categories = Object.keys(queries);
  if (niche === "random") {
    niche = categories[Math.floor(Math.random() * categories.length)];
  } else if (!queries[niche]) {
    logs &&
      log(
        `[QUERY] - Unknown niche "${niche}", falling back to random category.`,
        "warning",
      );
    niche = categories[Math.floor(Math.random() * categories.length)];
  }
  searchQuery = pickSearchTemplate(niche, queries, usedSearchQueryTemplates);
  if (!searchQuery) {
    logs &&
      log(
        `[QUERY] - No query templates available for niche "${niche}".`,
        "error",
      );
    return false;
  }
  const currentYear = new Date().getFullYear();
  const country = config?.user?.country || "";
  searchQuery = searchQuery
    .replace(/\[year\]/g, currentYear.toString())
    .replace(/\[country\]/g, country);
  searchQuery = addErrors(searchQuery);
  logs && log(`[QUERY] - Search query: ${searchQuery}`, "update");

  let debuggerTypedQuery = false;
  try {
    await enableDomains(tabId);
    const isAttached = await isDebuggerAttached(tabId);
    if (!isAttached) {
      await attach(tabId, interruptible);
      await delay(shortestDelay, interruptible);
    }
    const expression = `(function() {
			const input = document.querySelector("#sb_form_q");
			if (input) {
				input.focus();
				input.value = "";
				input.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
			return false;
		})()`;
    await race(
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: expression,
        allowUnsafeEvalBlockedByCSP: true,
        returnByValue: true,
      }),
      shortestDelay,
      `Failed to clear search input for tab ${tabId} within timeout.`,
    );
    await delay(250 + Math.random() * 250, interruptible);
    // Batch the full query into a single insertText for speed.
    // Still pause between words to look human.
    const words = searchQuery.split(" ");
    for (let wi = 0; wi < words.length; wi++) {
      if (!config?.runtime?.running) {
        logs &&
          log("[QUERY] Interrupted during typing, stopping query.", "warning");
        return false;
      }
      const word = (wi > 0 ? " " : "") + words[wi];
      await race(
        chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
          text: word,
        }),
        shortestDelay,
        `Failed to insert text for tab ${tabId} within timeout.`,
      );
      await delay(
        typingDelayMin + Math.random() * (typingDelayMax - typingDelayMin),
        interruptible,
      );
    }
    debuggerTypedQuery = true;
    logs && log(`[QUERY] - Search query typed: ${searchQuery}`, "update");
    await delay(300 + Math.random() * 300, interruptible);
  } catch (error) {
    log(`[QUERY] - Error during query operation: ${error.message}`, "error");
  }

  if (interruptible && !config?.runtime?.running) {
    logs &&
      log("[QUERY] Interrupted before content-script fallback.", "warning");
    return false;
  }

  if (debuggerTypedQuery) {
    logs && log(`[QUERY] - Search query ready: ${searchQuery}`, "update");
    return true;
  }

  const response = await sendTabMessage(
    tabId,
    {
      action: "query",
      query: searchQuery,
    },
    "QUERY",
  );
  if (!response || response.success === false) {
    log(
      `[QUERY] - Content script did not confirm query: ${response?.message || "no response"}`,
      "error",
    );
    return false;
  }
  await delay(300 + Math.random() * 300, interruptible);
  logs && log(`[QUERY] - Search query sent: ${searchQuery}`, "update");
  return true;
}

function addErrors(
  query,
  errorRate = 0.003,
  swapRate = 0.003,
  chancesOfError = 0.04,
) {
  if (Math.random() > chancesOfError) return query;
  const keyboardMap = {
    a: ["s", "q", "w", "z"],
    b: ["v", "g", "h", "n"],
    c: ["x", "d", "f", "v"],
    d: ["s", "e", "r", "f", "c", "x"],
    e: ["w", "s", "d", "r"],
    f: ["d", "r", "t", "g", "v", "c"],
    g: ["f", "t", "y", "h", "b", "v"],
    h: ["g", "y", "u", "j", "n", "b"],
    i: ["u", "j", "k", "o"],
    j: ["h", "u", "i", "k", "m", "n"],
    k: ["j", "i", "o", "l", "m"],
    l: ["k", "o", "p"],
    m: ["n", "j", "k"],
    n: ["b", "h", "j", "m"],
    o: ["i", "k", "l", "p"],
    p: ["o", "l"],
    q: ["a", "w"],
    r: ["e", "d", "f", "t"],
    s: ["a", "w", "e", "d", "x", "z"],
    t: ["r", "f", "g", "y"],
    u: ["y", "h", "j", "i"],
    v: ["c", "f", "g", "b"],
    w: ["q", "a", "s", "e"],
    x: ["z", "s", "d", "c"],
    y: ["t", "g", "h", "u"],
    z: ["a", "s", "x"],
  };
  const getNearbyChar = (char) => {
    const lower = char.toLowerCase();
    const neighbors = keyboardMap[lower];
    if (!neighbors || neighbors.length === 0) return char;
    const swap = neighbors[Math.floor(Math.random() * neighbors.length)];
    return char === lower ? swap : swap.toUpperCase();
  };
  let result = "";
  let errorCount = 0;
  for (let i = 0; i < query.length; i++) {
    let char = query[i];
    if (errorCount < 2 && /[a-zA-Z]/.test(char)) {
      const roll = Math.random();
      if (roll < errorRate) {
        // Delete character
        errorCount++;
        continue;
      } else if (roll < errorRate * 2) {
        // Duplicate character
        result += char + char;
        errorCount++;
        continue;
      } else if (roll < errorRate * 2 + swapRate) {
        // Swap to nearby key
        result += getNearbyChar(char);
        errorCount++;
        continue;
      }
    }
    result += char;
  }
  return result;
}

async function perform(interruptible = true) {
  if (interruptible && !config?.runtime?.running) {
    logs &&
      log("[PERFORM] Interrupted, skipping perform operation.", "warning");
    return false;
  }
  const tabId = Number(config?.runtime?.rsaTab);
  if (!tabId) {
    logs &&
      log("[PERFORM] No RSA tab found, skipping perform operation.", "warning");
    return false;
  }
  if (!(await ensureEmulation(tabId))) {
    logs &&
      log(
        "[PERFORM] Mobile emulation is not ready; skipping search submit.",
        "warning",
      );
    return false;
  }
  const originalUrl = await getTabUrl(tabId);
  logs && log("[PERFORM] Starting perform operation...", "update");
  try {
    await enableDomains(tabId);
    const response = await sendTabMessage(
      tabId,
      {
        action: "perform",
        query: searchQuery,
      },
      "PERFORM",
    );
    if (!response || response.success === false) {
      throw new Error(
        response?.message || "Content script perform did not respond.",
      );
    }
    logs && log(`[PERFORM] - Search query sent: ${searchQuery}`, "update");
    const navigation = await waitForUrl(
      tabId,
      (url) =>
        url !== originalUrl && isConfirmedBingSearchUrl(url, searchQuery),
      longestDelay,
    );
    if (navigation.success) {
      await wait(tabId);
    } else {
      await delay(mediumDelay, interruptible);
    }
    await delay(shortestDelay, interruptible);
    const newUrl = await getTabUrl(tabId);
    if (
      newUrl &&
      newUrl !== originalUrl &&
      isConfirmedBingSearchUrl(newUrl, searchQuery)
    ) {
      logs &&
        log(
          `[PERFORM] - Search performed. URL changed from ${originalUrl} to ${newUrl}`,
          "success",
        );
      return true;
    } else {
      logs &&
        log(
          `[PERFORM] - Search failed and URL did not change: ${originalUrl}`,
          "error",
        );
      return false;
    }
  } catch (error) {
    log(
      `[PERFORM] - Error during perform operation: ${error.message}`,
      "error",
    );
    return false;
  }
}

async function search(searches, min, max, interruptible = true) {
  searches = Number(searches) || 0;
  min = Number(min) || defaultSearchDelayMin;
  max = Number(max) || defaultSearchDelayMax;
  min = Math.max(minimumSearchDelay, min);
  if (max < min) max = min;
  if (interruptible && !config?.runtime?.running) {
    diagnosticLog(
      "[SEARCH] Interrupted, skipping search operation.",
      "warning",
    );
    return false;
  }
  if (!navigator.onLine) {
    diagnosticLog(
      "[SEARCH] No internet connection, skipping search operation.",
      "warning",
    );
    return false;
  }
  if (!searches) {
    diagnosticLog(
      "[SEARCH] No searches provided, skipping search operation.",
      "warning",
    );
    return false;
  }
  diagnosticLog("[SEARCH] Starting search operation...", "update");
  const tabId = Number(config?.runtime?.rsaTab);
  const originalUrl = await getTabUrl(tabId);
  const clearIt = config?.control?.clear;

  if (clearIt && !config?.runtime?.mobile) await clear();
  await delay(shortestDelay, interruptible);
  if (originalUrl && originalUrl !== bing) {
    await chrome.tabs.update(tabId, {
      url: bing,
    });
    await wait(tabId);
    await delay(shortestDelay, interruptible);
    diagnosticLog(`[SEARCH] Tab updated to Bing URL: ${bing}`, "update");
  }
  searchKeepaliveCancel = startSearchKeepalive(tabId);

  let successfulSearches = 0;
  const updateProgressBadge = async () => {
    const total = Number(config?.runtime?.total) || searches || 1;
    await chrome.action.setBadgeText({
      text:
        Math.round(
          ((config.runtime.done + config.runtime.failed) / total) * 100,
        ) + "%",
    });
  };
  const randomBetween = (minMs, maxMs) =>
    Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const getReadDelay = () => {
    const baseDelay = randomBetween(min * 1000, max * 1000);
    if (Math.random() < 0.12) {
      return baseDelay + randomBetween(3000, 7000);
    }
    return baseDelay;
  };
  const waitAfterIteration = async (index, readDelay, searched = true) => {
    if (!searched) {
      diagnosticLog(
        "[SEARCH] Waiting briefly after failed search...",
        "update",
      );
      await delay(
        randomBetween(failedSearchSettleDelayMin, failedSearchSettleDelayMax),
        interruptible,
      );
      return;
    }

    if (index === searches - 1) {
      const finalDelay = Math.min(readDelay, finalSearchSettleDelayMax);
      diagnosticLog(
        "[SEARCH] Waiting for final results read delay...",
        "update",
      );
      await delay(finalDelay, interruptible);
      return;
    }

    diagnosticLog(
      "[SEARCH] Waiting on results before next search...",
      "update",
    );
    await delay(readDelay, interruptible);
    await delay(
      randomBetween(betweenSearchDelayMin, betweenSearchDelayMax),
      interruptible,
    );
  };

  try {
    for (let i = 0; i < searches; i++) {
      let clickedForPatch = false;
      if (interruptible && !config?.runtime?.running) {
        diagnosticLog(
          "[SEARCH] Interrupted, skipping search operation.",
          "warning",
        );
        return false;
      }
      if (!navigator.onLine) {
        diagnosticLog(
          "[SEARCH] No internet connection, skipping search operation.",
          "warning",
        );
        return false;
      }
      if (needPatch && clearIt && config?.runtime?.mobile) {
        diagnosticLog(
          "[SEARCH] Mobile patch: refreshing cache while preserving Microsoft login...",
          "warning",
        );
        await clear(interruptible, false);
        await delay(shortestDelay, interruptible);
        clickedForPatch = await click(interruptible);
        await delay(shortestDelay, interruptible);
      }
      const readDelay = getReadDelay();
      if (clearIt && i < 3 && !clickedForPatch) {
        await chrome.tabs.update(tabId, {
          active: true,
        });
        await delay(shortestDelay, interruptible);
        await click(interruptible);
        await delay(shortestDelay, interruptible);
      }
      const queried = await query(interruptible);
      if (!queried) {
        config.runtime.failed++;
        await set(config);
        await updateProgressBadge();
        diagnosticLog(`[SEARCH] Query failed for ${searchQuery}.`, "error");
        await waitAfterIteration(i, readDelay, false);
        continue;
      }
      await delay(
        randomBetween(preSubmitDelayMin, preSubmitDelayMax),
        interruptible,
      );
      // NOTE: Do NOT re-read storage here — it would overwrite in-memory
      // runtime.done/failed counters if popup wrote config concurrently.
      const searched = await perform(interruptible);
      if (!config?.runtime?.running) {
        // Run was stopped during perform(): don't count it as a real failure or
        // navigate the tab (which may already be closing).
        break;
      }
      if (!searched) {
        await chrome.tabs.update(tabId, {
          url: bing,
          active: true,
        });
        await wait(tabId);
        config.runtime.failed++;
        diagnosticLog(
          `[SEARCH] Search ${i + 1} failed with query: ${searchQuery}.`,
          "error",
        );
      } else {
        config.runtime.done++;
        successfulSearches++;
        diagnosticLog(
          `[SEARCH] Search ${i + 1} performed with query: ${searchQuery}.`,
          "success",
        );
      }
      await set(config);
      await updateProgressBadge();
      await waitAfterIteration(i, readDelay, searched);
    }
  } finally {
    if (searchKeepaliveCancel) {
      searchKeepaliveCancel();
      searchKeepaliveCancel = null;
    }
  }

  if (interruptible && !config?.runtime?.running) {
    diagnosticLog(
      "[SEARCH] Search phase stopped before completion.",
      "warning",
    );
    return false;
  }
  await chrome.tabs.update(tabId, {
    url: loading + "complete",
  });
  await wait(tabId);
  if (successfulSearches === 0) {
    diagnosticLog(
      "[SEARCH] Phase completed, but no searches were confirmed.",
      "warning",
    );
    return false;
  }
  if (!isCompleteSearchCount(successfulSearches, searches)) {
    diagnosticLog(
      `[SEARCH] Phase incomplete: ${successfulSearches}/${searches} searches confirmed.`,
      "warning",
    );
    return false;
  }
  return true;
}

async function waitForUrl(
  tabId,
  predicate,
  timeout = longestDelay * 2,
  interruptible = true,
) {
  const startTime = Date.now();
  const startedAtGen = _getRunGeneration();
  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    let interruptTimer = null;

    const done = (success, url = "") => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(interruptTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      logs &&
        log(
          `[WAIT URL] ${success ? "Matched" : "Timed out"} for tab ${tabId}: ${url} (${Date.now() - startTime}ms)`,
          success ? "success" : "warning",
        );
      resolve({ success, url });
    };

    const checkCurrentUrl = async () => {
      try {
        const url = await getTabUrl(tabId);
        if (predicate(url || "")) {
          done(true, url);
        }
      } catch (error) {}
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      const url = changeInfo.url || tab?.url || "";
      if (predicate(url)) {
        done(true, url);
        return;
      }
      if (changeInfo.status === "complete") {
        checkCurrentUrl();
      }
    };

    timer = setTimeout(async () => {
      const url = await getTabUrl(tabId);
      done(false, url || "");
    }, timeout);

    if (interruptible) {
      interruptTimer = setInterval(() => {
        if (
          !config?.runtime?.running &&
          _getRunGeneration() === startedAtGen &&
          !resolved
        ) {
          done(false, "");
        }
      }, 100);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    checkCurrentUrl();
  });
}

async function completeRewardActivityTab(
  tabId,
  shouldContinue = isRuntimeActive,
) {
  tabId = Number(tabId);
  if (!tabId) return false;

  let attachedHere = false;
  let interactions = 0;
  try {
    if (!shouldContinue()) return false;
    const loaded = await wait(tabId, true);
    if (!loaded || !shouldContinue()) return false;
    await delay(mediumDelay, true);
    if (!shouldContinue()) return false;

    const alreadyAttached = await isDebuggerAttached(tabId);
    if (!alreadyAttached) {
      attachedHere = await attach(tabId, false);
    }
    if (!alreadyAttached && !attachedHere) return false;
    if (!shouldContinue()) return false;

    await enableDomains(tabId);

    const solveScript = createSolveActivityScript();

    for (let attempt = 0; attempt < 8; attempt++) {
      if (!shouldContinue()) break;
      const result = await race(
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: solveScript,
          returnByValue: true,
        }),
        mediumDelay,
        `Failed to interact with reward tab ${tabId}.`,
      ).catch((error) => {
        logs &&
          log(
            `[ACTIVITY] Reward tab interaction failed: ${error.message}`,
            "warning",
          );
        return null;
      });
      const value = result?.result?.value;
      if (!value?.clicked) break;

      interactions++;
      logs &&
        log(`[ACTIVITY] Reward tab ${tabId} clicked: ${value.text}`, "update");
      if (!shouldContinue()) break;
      await delay(1200 + Math.random() * 800, true);
      if (!shouldContinue()) break;
      await wait(tabId, true);
    }
  } catch (error) {
    logs &&
      log(
        `[ACTIVITY] Error completing reward tab ${tabId}: ${error.message}`,
        "error",
      );
  } finally {
    if (attachedHere) {
      await detach(tabId, false);
    }
  }

  return interactions > 0;
}

function isRewardActivityUrl(url) {
  return isTrustedRewardActivityUrl(url, msDomains);
}

function getTabActivityUrl(tab) {
  return String(tab?.url || tab?.pendingUrl || "").toLowerCase();
}

function isActivityOpenedTab(tab, mainTabId, existingTabIds) {
  return isTrustedActivityOpenedTab(tab, mainTabId, existingTabIds, msDomains);
}

async function processOpenedActivityTabs(
  mainTabId,
  existingTabIds,
  returnUrl = rewards + "dashboard",
  shouldContinue = isRuntimeActive,
) {
  const allTabs = await chrome.tabs.query({});
  if (!shouldContinue()) return 0;
  const newTabs = allTabs.filter((tab) =>
    isActivityOpenedTab(tab, mainTabId, existingTabIds),
  );
  let processed = 0;
  for (const tab of newTabs) {
    if (!shouldContinue()) break;
    const loaded = await waitForUrl(
      tab.id,
      (url) => Boolean(url && url !== "about:blank"),
      longestDelay,
    );
    const tabUrl = loaded.url || (await getTabUrl(tab.id));
    if (!shouldContinue()) break;
    if (!isRewardActivityUrl(tabUrl)) {
      logs &&
        log(
          `[ACTIVITY] Leaving non-reward tab open: ${tab.id} (${tabUrl || "unknown url"})`,
          "update",
        );
      continue;
    }
    const completed = await completeRewardActivityTab(tab.id, shouldContinue);
    await delay(shortestDelay, false);
    try {
      await chrome.tabs.remove(tab.id);
    } catch (error) {}
    if (completed) {
      processed++;
    }
    logs &&
      log(
        `[ACTIVITY] Closed opened tab: ${tab.id} (${tabUrl || "unknown url"}) - ${completed ? "completed" : "not completed"}`,
        completed ? "update" : "warning",
      );
  }

  if (!shouldContinue()) return processed;
  const mainUrl = await getTabUrl(mainTabId);
  if (
    shouldContinue() &&
    mainUrl &&
    isRewardActivityUrl(mainUrl) &&
    !mainUrl.startsWith(returnUrl)
  ) {
    const completed = await completeRewardActivityTab(
      mainTabId,
      shouldContinue,
    );
    if (!shouldContinue()) return processed;
    await chrome.tabs.update(mainTabId, { url: returnUrl, active: true });
    await wait(mainTabId);
    if (completed) {
      processed++;
    }
  }

  return processed;
}

async function closeOpenedActivityTabs(mainTabId, existingTabIds) {
  const allTabs = await chrome.tabs.query({});
  const openedTabs = allTabs.filter(
    (tab) =>
      isActivityOpenedTab(tab, mainTabId, existingTabIds) &&
      isRewardActivityUrl(getTabActivityUrl(tab)),
  );
  let closed = 0;
  for (const tab of openedTabs) {
    try {
      await chrome.tabs.remove(tab.id);
      closed++;
      logs &&
        log(
          `[ACTIVITY] Cleanup closed leftover tab: ${tab.id} (${tab.url || tab.pendingUrl || "unknown url"})`,
          "update",
        );
    } catch (error) {}
  }
  return closed;
}

async function dispatchTrustedPress(
  tabId,
  point,
  context = "ACTIVITY",
  shouldContinue = isRuntimeActive,
) {
  if (!shouldContinue()) return false;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    if (!shouldContinue()) return false;
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await delay(80, false);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return true;
  } catch (error) {
    logs &&
      log(
        `[${context}] Trusted click failed at (${Math.round(x)}, ${Math.round(y)}): ${error.message}`,
        "warning",
      );
    return false;
  }
}

async function runDashboardActivityPass(
  tabId,
  memory,
  sessionVisited,
  sessionMisses,
  pass,
  shouldContinue = isRuntimeActive,
) {
  const tabsBefore = await chrome.tabs.query({});
  const existingTabIds = new Set(tabsBefore.map((tab) => tab.id));
  const blockedKeys = getBlockedActivityKeys(memory, sessionVisited);
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const dashboardScript = createDashboardActivityScript(
    [...blockedKeys],
    1,
    true,
  );
  const result = await race(
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: dashboardScript,
      returnByValue: true,
    }),
    longestDelay,
    `Failed to scan rewards dashboard pass ${pass}.`,
  ).catch((error) => {
    diagnosticLog(
      `[ACTIVITY] Dashboard pass ${pass} failed: ${error.message}`,
      "warning",
    );
    return null;
  });

  const value = result?.result?.value || {};
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  let clickedItems = value.clicked || [];
  const skippedItems = value.skipped || [];
  if (clickedItems.length === 0) {
    diagnosticLog(
      `[ACTIVITY] Dashboard scan ${pass}: ${value.reason || "no runnable cards"}.`,
      "update",
    );
    return {
      clicked: 0,
      attempted: 0,
      processed: 0,
      skipped: skippedItems.length,
      retry: Boolean(value.retry),
      scanPosition: value.scanPosition,
      pointDelta: null,
    };
  }
  // Do not poll points or wait for child tabs when the scan found no action.
  const beforeScore = await fetchRewardsSnapshot();
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  if (clickedItems.length > 0 && value.pressPoint) {
    const pressed = await dispatchTrustedPress(
      tabId,
      value.pressPoint,
      "DAILY SET",
      shouldContinue,
    );
    if (!pressed) clickedItems = [];
  }
  if (value.reason) {
    diagnosticLog(
      `[ACTIVITY] Dashboard pass ${pass}: ${value.reason}.`,
      "warning",
    );
  }
  if (clickedItems.length > 0) {
    diagnosticLog(
      `[ACTIVITY] Pass ${pass} clicked ${clickedItems.length} dashboard items.`,
      "success",
    );
    for (const item of clickedItems) {
      diagnosticLog(
        `[ACTIVITY]   clicked ${item.type}: ${item.text}`,
        "update",
      );
    }
  }
  if (skippedItems.length > 0) {
    diagnosticLog(
      `[ACTIVITY] Pass ${pass} skipped ${skippedItems.length} completed items.`,
      "update",
    );
  }

  await delay(4000 + Math.random() * 2500, true);
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const processedTabs = await processOpenedActivityTabs(
    tabId,
    existingTabIds,
    rewards + "dashboard",
    shouldContinue,
  );
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const nonExpandClicks = clickedItems.filter((item) => item.type !== "expand");
  if (nonExpandClicks.length > 0 || processedTabs > 0) {
    await chrome.tabs.update(tabId, {
      url: rewards + "dashboard",
      active: true,
    });
    await wait(tabId);
    await delay(mediumDelay, true);
  }
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const afterScore = await fetchRewardsSnapshot();
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  let pointDelta = getScoreDelta(beforeScore, afterScore);
  if (afterScore && Number.isFinite(afterScore.score)) {
    memory.lastScore = afterScore.score;
  }
  // Points from a just-clicked card can lag the getuserinfo API by several
  // seconds. If we clicked something but neither a processed tab nor a positive
  // delta confirms it yet, wait longer and re-check once before deciding it was
  // a miss (a miss twice gets the card blocked for the rest of the session).
  if (
    clickedItems.length > 0 &&
    processedTabs === 0 &&
    !(Number.isFinite(pointDelta) && pointDelta > 0)
  ) {
    await delay(4000 + Math.random() * 2000, true);
    if (!shouldContinue()) return { clicked: 0, processed: 0 };
    const retryScore = await fetchRewardsSnapshot();
    if (!shouldContinue()) return { clicked: 0, processed: 0 };
    const retryDelta = getScoreDelta(beforeScore, retryScore);
    if (Number.isFinite(retryDelta)) pointDelta = retryDelta;
    if (retryScore && Number.isFinite(retryScore.score)) {
      memory.lastScore = retryScore.score;
    }
  }
  // Only a positive score delta confirms a click; a clicked-but-zero-delta card
  // stays a retryable miss (so multi-step quizzes get another pass). The
  // re-check above is what rescues the (often first) card whose points merely
  // register slowly, without falsely confirming a tab that opened but earned 0.
  const confirmedClick = Number.isFinite(pointDelta)
    ? pointDelta > 0
    : processedTabs > 0;
  let retryableMiss = false;
  if (confirmedClick) {
    confirmActivityKeys(
      memory,
      sessionVisited,
      sessionMisses,
      value.openedKeys || [],
    );
  } else if (clickedItems.length > 0) {
    const missed = markUnconfirmedActivityKeys(
      value.openedKeys || [],
      sessionVisited,
      sessionMisses,
    );
    retryableMiss = missed.retryable;
    diagnosticLog(
      `[ACTIVITY] Pass ${pass} daily-set click did not open/score; ${retryableMiss ? "retrying" : "moving on"}.`,
      "warning",
    );
  }
  await saveActivityMemory(memory);

  if (pointDelta !== null) {
    diagnosticLog(
      `[ACTIVITY] Pass ${pass} score delta: ${pointDelta >= 0 ? "+" : ""}${pointDelta}.`,
      pointDelta > 0 ? "success" : "warning",
    );
  }

  log(
    `[DIAG] Dashboard pass ${pass}: clicked=${JSON.stringify(
      clickedItems.map((c) => c.text),
    )} skipped=${JSON.stringify(
      skippedItems.map((s) => (s.reason ? `${s.text} <${s.reason}>` : s.text)),
    )} reason=${value.reason || "-"} delta=${pointDelta} processedTabs=${processedTabs} confirmed=${confirmedClick}`,
    "update",
  );

  return {
    clicked: confirmedClick ? clickedItems.length : 0,
    attempted: clickedItems.length,
    nonExpandClicked: confirmedClick ? nonExpandClicks.length : 0,
    processed: confirmedClick ? processedTabs : 0,
    skipped: skippedItems.length,
    retry: Boolean(value.retry) || retryableMiss,
    pointDelta,
    scanPosition: value.scanPosition,
  };
}

async function runEarnActivityPass(
  tabId,
  memory,
  sessionVisited,
  sessionMisses,
  pass,
  shouldContinue = isRuntimeActive,
) {
  const earnUrl = rewards + "earn";
  const tabsBefore = await chrome.tabs.query({});
  const existingTabIds = new Set(tabsBefore.map((tab) => tab.id));
  const blockedKeys = getBlockedActivityKeys(memory, sessionVisited);
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const earnScript = createEarnActivityScript([...blockedKeys], 1, true);
  const result = await race(
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: earnScript,
      returnByValue: true,
    }),
    longestDelay,
    `Failed to scan rewards earn pass ${pass}.`,
  ).catch((error) => {
    diagnosticLog(
      `[ACTIVITY] Earn pass ${pass} failed: ${error.message}`,
      "warning",
    );
    return null;
  });

  const value = result?.result?.value || {};
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  let clickedItems = value.clicked || [];
  const skippedItems = value.skipped || [];
  if (clickedItems.length === 0) {
    diagnosticLog(
      `[ACTIVITY] Earn scan ${pass}: ${value.reason || "no runnable cards"}.`,
      "update",
    );
    return {
      clicked: 0,
      attempted: 0,
      processed: 0,
      skipped: skippedItems.length,
      retry: Boolean(value.retry),
      scanPosition: value.scanPosition,
      pointDelta: null,
    };
  }
  const beforeScore = await fetchRewardsSnapshot();
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  if (value.pressPoint) {
    const pressed = await dispatchTrustedPress(
      tabId,
      value.pressPoint,
      "KEEP EARNING",
      shouldContinue,
    );
    if (!pressed) clickedItems = [];
  }
  if (value.reason) {
    diagnosticLog(`[ACTIVITY] Earn pass ${pass}: ${value.reason}.`, "warning");
  }
  if (clickedItems.length > 0) {
    diagnosticLog(
      `[ACTIVITY] Earn pass ${pass} clicked ${clickedItems.length} Keep earning items.`,
      "success",
    );
    for (const item of clickedItems) {
      diagnosticLog(
        `[ACTIVITY]   clicked ${item.type}: ${item.text}`,
        "update",
      );
    }
  }
  if (skippedItems.length > 0) {
    diagnosticLog(
      `[ACTIVITY] Earn pass ${pass} skipped ${skippedItems.length} non-point, locked, or completed items.`,
      "update",
    );
  }

  await delay(4000 + Math.random() * 2500, true);
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const processedTabs = await processOpenedActivityTabs(
    tabId,
    existingTabIds,
    earnUrl,
    shouldContinue,
  );
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  if (clickedItems.length > 0 || processedTabs > 0) {
    await chrome.tabs.update(tabId, { url: earnUrl, active: true });
    await wait(tabId);
    await delay(mediumDelay, true);
  }
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  const afterScore = await fetchRewardsSnapshot();
  if (!shouldContinue()) return { clicked: 0, processed: 0 };
  let pointDelta = getScoreDelta(beforeScore, afterScore);
  if (afterScore && Number.isFinite(afterScore.score)) {
    memory.lastScore = afterScore.score;
  }
  // Same lag handling as the dashboard pass: re-check the score once before
  // concluding a clicked earn card did not score.
  if (
    clickedItems.length > 0 &&
    processedTabs === 0 &&
    !(Number.isFinite(pointDelta) && pointDelta > 0)
  ) {
    await delay(4000 + Math.random() * 2000, true);
    if (!shouldContinue()) return { clicked: 0, processed: 0 };
    const retryScore = await fetchRewardsSnapshot();
    if (!shouldContinue()) return { clicked: 0, processed: 0 };
    const retryDelta = getScoreDelta(beforeScore, retryScore);
    if (Number.isFinite(retryDelta)) pointDelta = retryDelta;
    if (retryScore && Number.isFinite(retryScore.score)) {
      memory.lastScore = retryScore.score;
    }
  }
  // Only a positive delta confirms; the re-check above gives lagging points
  // time to land without falsely confirming a tab that opened but earned 0.
  const confirmedClick = Number.isFinite(pointDelta)
    ? pointDelta > 0
    : processedTabs > 0;
  let retryableMiss = false;
  if (confirmedClick) {
    confirmActivityKeys(
      memory,
      sessionVisited,
      sessionMisses,
      value.openedKeys || [],
    );
  } else if (clickedItems.length > 0) {
    const missed = markUnconfirmedActivityKeys(
      value.openedKeys || [],
      sessionVisited,
      sessionMisses,
    );
    retryableMiss = missed.retryable;
    diagnosticLog(
      `[ACTIVITY] Earn pass ${pass} click did not open/score; ${retryableMiss ? "retrying" : "moving on"}.`,
      "warning",
    );
  }
  await saveActivityMemory(memory);

  if (pointDelta !== null) {
    diagnosticLog(
      `[ACTIVITY] Earn pass ${pass} score delta: ${pointDelta >= 0 ? "+" : ""}${pointDelta}.`,
      pointDelta > 0 ? "success" : "warning",
    );
  }

  log(
    `[DIAG] Earn pass ${pass}: clicked=${JSON.stringify(
      clickedItems.map((c) => c.text),
    )} skipped=${JSON.stringify(
      skippedItems.map((s) => (s.reason ? `${s.text} <${s.reason}>` : s.text)),
    )} reason=${value.reason || "-"} delta=${pointDelta} processedTabs=${processedTabs} confirmed=${confirmedClick}`,
    "update",
  );

  return {
    clicked: confirmedClick ? clickedItems.length : 0,
    attempted: clickedItems.length,
    processed: confirmedClick ? processedTabs : 0,
    skipped: skippedItems.length,
    retry: Boolean(value.retry) || retryableMiss,
    pointDelta,
    scanPosition: value.scanPosition,
  };
}

// Silent "Ready to claim" collector: clicks the pending-points card on the
// dashboard and confirms it actually collected via the Rewards score delta.
async function runClaimReadyPass(
  tabId,
  pass,
  shouldContinue = isRuntimeActive,
) {
  if (!shouldContinue()) return { clicked: false };
  const claimScript = createClaimReadyScript(true);
  const result = await race(
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: claimScript,
      returnByValue: true,
    }),
    longestDelay,
    `Failed to run ready-to-claim pass ${pass}.`,
  ).catch((error) => {
    diagnosticLog(
      `[ACTIVITY] Claim pass ${pass} failed: ${error.message}`,
      "warning",
    );
    return null;
  });

  const value = result?.result?.value || {};
  if (!shouldContinue()) return { clicked: false };
  let clicked = Boolean(value.clicked);
  if (!clicked)
    return {
      clicked: false,
      retry: Boolean(value.retry),
      count: value.count,
      pointDelta: null,
    };
  const beforeScore = await fetchRewardsSnapshot();
  if (!shouldContinue()) return { clicked: false };
  if (clicked && value.pressPoint) {
    clicked = await dispatchTrustedPress(
      tabId,
      value.pressPoint,
      "CLAIM",
      shouldContinue,
    );
  }
  if (value.reason) {
    diagnosticLog(`[ACTIVITY] Claim pass ${pass}: ${value.reason}.`, "update");
  }
  if (clicked) {
    diagnosticLog(
      `[ACTIVITY] Claim pass ${pass} clicked "${value.text || "claim"}" (pending: ${value.count}).`,
      "update",
    );
  }

  let pointDelta = null;
  if (clicked) {
    // Opening the card is only stage one; return quickly so the next pass can
    // click the dialog confirm. After the confirm, poll longer for API lag.
    const checks = value.stage === "confirm" ? 4 : 1;
    for (let check = 0; check < checks; check++) {
      if (!shouldContinue()) break;
      await delay(
        value.stage === "confirm"
          ? 2500 + Math.random() * 1200
          : 1200 + Math.random() * 600,
        true,
      );
      if (!shouldContinue()) break;
      const afterScore = await fetchRewardsSnapshot();
      pointDelta = getScoreDelta(beforeScore, afterScore);
      if (Number.isFinite(pointDelta) && pointDelta > 0) break;
    }
  }
  if (Number.isFinite(pointDelta) && pointDelta !== 0) {
    diagnosticLog(
      `[ACTIVITY] Claim pass ${pass} score delta: ${pointDelta > 0 ? "+" : ""}${pointDelta}.`,
      pointDelta > 0 ? "success" : "update",
    );
  }

  log(
    `[DIAG] Claim pass ${pass}: clicked=${clicked} stage=${value.stage || "-"} count=${value.count} text="${(value.text || "").slice(0, 60)}" reason=${value.reason || "-"} delta=${pointDelta} url=${value.url || "-"}`,
    "update",
  );

  return {
    clicked,
    retry: Boolean(value.retry),
    count: Number.isFinite(value.count) ? value.count : null,
    pointDelta,
  };
}

async function activity(tabId, interruptible = true, options = {}) {
  // Manual "activities only" runs pass recordRun:false so they don't consume the
  // automated daily activity quota (which would otherwise block scheduled runs).
  const recordRun = options.recordRun !== false;
  const expectedSessionId =
    options.expectedSessionId || config?.runtime?.currentSession?.id;
  const ownsActivity = () => isSessionStillActive(expectedSessionId);
  const shouldContinueActivity = () => ownsActivity() && isRuntimeActive();
  if (!shouldContinueActivity()) return false;
  if (interruptible && !config?.runtime?.running && !config?.runtime?.act) {
    diagnosticLog(`[ACTIVITY] Interrupted, skipping activity.`, "warning");
    return false;
  }
  if (!navigator.onLine) {
    diagnosticLog(`[ACTIVITY] No internet connection, skipping.`, "warning");
    return false;
  }
  tabId = Number(tabId);
  if (!tabId) {
    diagnosticLog(`[ACTIVITY] No tab ID, skipping.`, "warning");
    return false;
  }

  diagnosticLog(
    `[ACTIVITY] Starting for session ${expectedSessionId}, tab ${tabId}.`,
  );
  config.runtime.act = 1;
  config.runtime.rsaTab = tabId;
  config.runtime.currentPhase = "activities";
  config.runtime.lastRunMessage = "Running Rewards activities.";
  await set(config);
  const activityStartTabs = new Set(
    (await chrome.tabs.query({})).map((tab) => tab.id),
  );
  let clicked = false;
  let debuggerReady = false;
  let activityMemory = null;
  let meaningfulActivityRun = false;
  let sessionFailed = false;
  let activityStopped = false;
  let result = false;
  let activityErrorMessage = "";
  try {
    if (!shouldContinueActivity()) return false;
    await chrome.action.setBadgeText({ text: "ACT" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0072FF" });

    await chrome.tabs.update(tabId, {
      url: rewards + "dashboard",
      active: true,
    });
    await wait(tabId);
    await delay(mediumDelay, interruptible);
    if (!shouldContinueActivity()) return false;

    let rewardsSessionOk = await isRewardsSessionActive(tabId);
    if (!shouldContinueActivity()) return false;
    if (!rewardsSessionOk) {
      diagnosticLog(
        `[ACTIVITY] Rewards session not detected; reloading dashboard once...`,
        "warning",
      );
      await chrome.tabs.update(tabId, {
        url: rewards + "dashboard",
        active: true,
      });
      await wait(tabId);
      await delay(mediumDelay, interruptible);
      rewardsSessionOk = await isRewardsSessionActive(tabId);
      if (!shouldContinueActivity()) return false;
    }
    diagnosticLog(
      `[ACTIVITY] Microsoft session: ${rewardsSessionOk ? "active" : "unavailable"}.`,
    );
    if (!rewardsSessionOk) {
      sessionFailed = true;
      diagnosticLog(
        `[ACTIVITY] Rewards login unavailable; cannot run Daily set or Keep earning.`,
        "error",
      );
    }

    if (!sessionFailed) {
      debuggerReady = await attach(tabId, interruptible);
      if (!shouldContinueActivity()) return false;
      if (!debuggerReady) {
        diagnosticLog(
          `[ACTIVITY] First debugger attach failed; retrying once...`,
          "warning",
        );
        await delay(mediumDelay, interruptible);
        debuggerReady = await attach(tabId, interruptible);
        if (!shouldContinueActivity()) return false;
      }
      if (!debuggerReady) {
        diagnosticLog(
          `[ACTIVITY] Debugger attach failed after retry; cannot scan activity cards.`,
          "error",
        );
      } else {
        await enableDomains(tabId);
      }

      await sendTabMessage(tabId, { action: "closePopups" }, "ACTIVITY");
      await delay(shortestDelay, interruptible);
      if (!shouldContinueActivity()) return false;

      activityMemory = await loadActivityMemory();
      const sessionVisited = new Set();
      let totalClicked = 0;
      let totalProcessed = 0;
      let measuredDelta = 0;
      let scanTracker = createActivityScanTracker();
      const sessionMisses = new Map();

      if (debuggerReady) {
        for (let pass = 1; pass <= 35; pass++) {
          if (!shouldContinueActivity()) {
            activityStopped = true;
            break;
          }
          const passResult = await runDashboardActivityPass(
            tabId,
            activityMemory,
            sessionVisited,
            sessionMisses,
            pass,
            shouldContinueActivity,
          );
          totalClicked += passResult.clicked;
          totalProcessed += passResult.processed;
          if (Number.isFinite(passResult.pointDelta)) {
            measuredDelta += passResult.pointDelta;
          }
          if (
            passResult.clicked > 0 ||
            passResult.processed > 0 ||
            (Number.isFinite(passResult.pointDelta) &&
              passResult.pointDelta > 0)
          ) {
            meaningfulActivityRun = true;
          }
          clicked = totalClicked > 0 || totalProcessed > 0;

          const decision = scanTracker.observe(passResult);
          if (decision.stop) {
            diagnosticLog(
              `[ACTIVITY] Daily set finished scanning: ${decision.reason}.`,
              "update",
            );
            break;
          }
          if (
            !passResult.attempted &&
            !passResult.clicked &&
            !passResult.processed
          )
            await delay(500, interruptible);
        }
      } else {
        diagnosticLog(
          `[ACTIVITY] Skipping dashboard and earn passes.`,
          "warning",
        );
      }

      if (debuggerReady && shouldContinueActivity()) {
        if (totalClicked === 0 && totalProcessed === 0) {
          diagnosticLog(
            `[ACTIVITY] Daily set idle, moving to Keep earning.`,
            "update",
          );
        }
        diagnosticLog(`[ACTIVITY] Opening Keep earning page.`, "update");
        await chrome.tabs.update(tabId, {
          url: rewards + "earn",
          active: true,
        });
        await wait(tabId);
        await delay(mediumDelay, interruptible);
        await sendTabMessage(tabId, { action: "closePopups" }, "ACTIVITY");
        scanTracker = createActivityScanTracker();

        for (let pass = 1; pass <= 45; pass++) {
          if (!shouldContinueActivity()) {
            activityStopped = true;
            break;
          }
          const passResult = await runEarnActivityPass(
            tabId,
            activityMemory,
            sessionVisited,
            sessionMisses,
            pass,
            shouldContinueActivity,
          );
          totalClicked += passResult.clicked;
          totalProcessed += passResult.processed;
          if (Number.isFinite(passResult.pointDelta)) {
            measuredDelta += passResult.pointDelta;
          }
          if (
            passResult.clicked > 0 ||
            passResult.processed > 0 ||
            (Number.isFinite(passResult.pointDelta) &&
              passResult.pointDelta > 0)
          ) {
            meaningfulActivityRun = true;
          }
          clicked = totalClicked > 0 || totalProcessed > 0;

          const decision = scanTracker.observe(passResult);
          if (decision.stop) {
            diagnosticLog(
              `[ACTIVITY] Keep earning finished scanning: ${decision.reason}.`,
              "update",
            );
            break;
          }
          if (
            !passResult.attempted &&
            !passResult.clicked &&
            !passResult.processed
          )
            await delay(500, interruptible);
        }
      } else if (!debuggerReady) {
        diagnosticLog(
          `[ACTIVITY] Keep earning skipped because debugger attach failed.`,
          "warning",
        );
      } else if (activityStopped) {
        diagnosticLog(
          `[ACTIVITY] Keep earning skipped because activity was stopped.`,
          "warning",
        );
      }

      // Silent final step: collect any "Ready to claim" pending points that
      // remain after Daily set + Keep earning. Best-effort; a failure here must
      // never break the run, so it is fully guarded.
      if (debuggerReady && shouldContinueActivity()) {
        try {
          diagnosticLog(
            `[ACTIVITY] Checking for ready-to-claim points.`,
            "update",
          );
          // The "Ready to claim" pending-points widget lives on the Rewards
          // HOMEPAGE (rewards.bing.com/), not /dashboard — the new React UI
          // shows the card there and opens a "Claim points" flyout. Claiming on
          // /dashboard silently finds nothing.
          await chrome.tabs.update(tabId, {
            url: rewards,
            active: true,
          });
          await wait(tabId);
          await delay(mediumDelay, interruptible);
          // A logged-out page has no claim card, so verify the Rewards session
          // first and reload once if it isn't detected yet (e.g. cookies were
          // still settling after the mobile phase).
          if (!(await isRewardsSessionActive(tabId))) {
            diagnosticLog(
              `[ACTIVITY] Rewards session not detected before claim; reloading page.`,
              "warning",
            );
            await chrome.tabs.reload(tabId);
            await wait(tabId);
            await delay(mediumDelay, interruptible);
          }
          await sendTabMessage(tabId, { action: "closePopups" }, "ACTIVITY");
          for (let pass = 1; pass <= 6; pass++) {
            if (!shouldContinueActivity()) break;
            const claimResult = await runClaimReadyPass(
              tabId,
              pass,
              shouldContinueActivity,
            );
            if (
              Number.isFinite(claimResult.pointDelta) &&
              claimResult.pointDelta > 0
            ) {
              meaningfulActivityRun = true;
              clicked = true;
              measuredDelta += claimResult.pointDelta;
            }
            // Stop when nothing was clickable or the pending count reached zero.
            if (claimResult.retry) {
              await delay(shortestDelay, true);
              continue;
            }
            if (!claimResult.clicked || claimResult.count === 0) break;
          }
        } catch (claimError) {
          diagnosticLog(
            `[ACTIVITY] Ready-to-claim step error: ${claimError.message}`,
            "warning",
          );
        }
      }

      diagnosticLog(
        `[ACTIVITY] Engine finished. Activity clicks: ${totalClicked}, processed tabs: ${totalProcessed}, measured delta: ${measuredDelta}.`,
        clicked ? "success" : "warning",
      );
      result = Boolean(clicked || meaningfulActivityRun);
    }
  } catch (error) {
    activityErrorMessage = error.message;
    diagnosticLog(`[ACTIVITY] Error: ${error.message}`, "error");
  } finally {
    if (sessionFailed) {
      diagnosticLog(
        `[ACTIVITY] Activity aborted because Rewards login was unavailable.`,
        "warning",
      );
    } else if (!clicked && !meaningfulActivityRun) {
      diagnosticLog(`[ACTIVITY] No activities to click.`, "warning");
    }
    if (
      ownsActivity() &&
      meaningfulActivityRun &&
      activityMemory &&
      recordRun
    ) {
      await recordActivityRun(activityMemory);
    } else if (meaningfulActivityRun && activityMemory && !recordRun) {
      diagnosticLog(
        `[ACTIVITY] Manual run — not counted toward the daily activity quota.`,
        "update",
      );
    } else if (!sessionFailed) {
      diagnosticLog(
        `[ACTIVITY] Run not counted because no activity cards were processed.`,
        "warning",
      );
    }
    if (debuggerReady) {
      await detach(tabId, false);
    }
    await closeOpenedActivityTabs(tabId, activityStartTabs);
    // A stopped activity may finish an awaited operation after a new run has
    // started. Cleanup of its own tabs is safe; changing the new runtime is not.
    if (ownsActivity()) {
      config.runtime.act = 0;
      if (Number(config.runtime.rsaTab) === tabId) config.runtime.rsaTab = null;
      config.runtime.lastRunMessage = activityErrorMessage
        ? `Activities failed: ${activityErrorMessage}`
        : sessionFailed
          ? "Activities could not start: sign in to Microsoft on Bing/Rewards."
          : !debuggerReady
            ? "Activities could not start: debugger attach failed. Close DevTools on the Rewards tab and retry."
            : result
              ? "Rewards activities completed."
              : "No activity completion was confirmed. Check Daily set and the activity log.";
      await chrome.action.setBadgeText({ text: "" });
      await set(config);
    }
  }
  return result;
}

async function initialise(searches, expectedSessionId = null) {
  if (expectedSessionId && !isSessionStillActive(expectedSessionId)) {
    logs &&
      log(
        `[INITIALISE] - Session ${expectedSessionId} is no longer active. Aborting.`,
        "warning",
      );
    return false;
  }

  const endedSessionType = config?.runtime?.currentSession?.type ?? null;
  _bumpRunGeneration();
  await resetRuntime(config);
  resetSearchQueryHistory();
  searches = normalizeSearchPlan(searches);
  searches = limitSearchPlanForToday(searches);
  const hasSearchPhase = searches.desk > 0 || searches.mob > 0;

  let tabId = null;
  let runSucceeded = false;
  let scheduleSucceeded = false;
  let failureMessage = "";
  try {
    if (!navigator.onLine) {
      failureMessage =
        "Cannot start: Chrome is offline. Check your internet connection and try again.";
      config.runtime.lastRunMessage = failureMessage;
      await set(config);
      logs &&
        log(
          "[INITIALISE] No internet connection, skipping initialisation.",
          "warning",
        );
      return false;
    }

    if (!hasSearchPhase && !hasActivityWork()) {
      logs &&
        log(
          "[INITIALISE] No searches or activities remaining for today, skipping.",
          "warning",
        );
      return false;
    }

    if (!hasSearchPhase) {
      logs &&
        log(
          "[INITIALISE] Daily searches complete; running activities only.",
          "update",
        );
      config.runtime.currentPhase = "activities";
      await set(config);
      const activityOnlyResult = await handlePostSearchTasks(
        searches,
        expectedSessionId,
        null,
        true,
        {
          isSessionStillActive,
          log: diagnosticLog,
          attachFn: attach,
          detachFn: detach,
          clearFn: clear,
          clickFn: click,
          waitFn: wait,
          delayFn: delay,
          createTabFn: (opts) => chrome.tabs.create(opts),
          removeTabFn: (id) => chrome.tabs.remove(id),
          updateTabFn: (id, opts) => chrome.tabs.update(id, opts),
          activityFn: (activityTabId, interruptible) =>
            activity(activityTabId, interruptible, { expectedSessionId }),
          shortestDelay,
          mediumDelay,
          rewards,
          bing,
          getConfig: () => config,
          hasActivityQuotaFn: hasActivityQuota,
        },
      );
      if (activityOnlyResult?.searchTabClosed) {
        tabId = null;
      }
      runSucceeded = Boolean(activityOnlyResult?.runSuccessful);
      scheduleSucceeded = Boolean(
        activityOnlyResult?.searchSuccessful ??
        activityOnlyResult?.runSuccessful,
      );
      return runSucceeded;
    }

    const rsaTab = await chrome.tabs.create({ url: bing, active: true });
    tabId = Number(rsaTab.id);
    config.runtime.rsaTab = tabId;
    config.runtime.total = searches.desk + searches.mob;
    await wait(tabId);
    await delay(shortestDelay, true);

    logs && log(`[INITIALISE] - Created new tab with ID: ${tabId}`, "update");

    await chrome.tabs.update(tabId, { autoDiscardable: false });
    await set(config);
    const debuggerAttached = await attach(tabId);
    if (!debuggerAttached) {
      throw new Error("Could not attach debugger to automation tab.");
    }
    await installFingerprintPatch(tabId);
    await delay(shortestDelay, true);
    await chrome.alarms.clear("schedule");
    await chrome.action.setBadgeText({ text: "0%" });
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0072FF" });

    config.runtime.currentPhase = "search";
    config.runtime.lastRunMessage = "Searches are running.";
    await set(config);

    const searchPhasesSuccessful = await runSearchPhases(
      searches,
      expectedSessionId,
      tabId,
      {
        isSessionStillActive,
        log: diagnosticLog,
        searchFn: search,
        simulateFn: simulate,
        clearFn: clear,
        setConfig: set,
        getConfig: () => config,
        delayFn: delay,
        shortestDelay,
        detachFn: detach,
      },
    );

    config.runtime.currentPhase = "post_search";
    await set(config);

    const postSearchResult = await handlePostSearchTasks(
      searches,
      expectedSessionId,
      tabId,
      searchPhasesSuccessful,
      {
        isSessionStillActive,
        log: diagnosticLog,
        attachFn: attach,
        detachFn: detach,
        clearFn: clear,
        clickFn: click,
        waitFn: wait,
        delayFn: delay,
        createTabFn: (opts) => chrome.tabs.create(opts),
        removeTabFn: (id) => chrome.tabs.remove(id),
        updateTabFn: (id, opts) => chrome.tabs.update(id, opts),
        activityFn: (activityTabId, interruptible) =>
          activity(activityTabId, interruptible, { expectedSessionId }),
        shortestDelay,
        mediumDelay,
        rewards,
        bing,
        getConfig: () => config,
        hasActivityQuotaFn: hasActivityQuota,
      },
    );
    if (postSearchResult?.searchTabClosed) {
      tabId = null;
    }

    runSucceeded = Boolean(postSearchResult?.runSuccessful);
    scheduleSucceeded = Boolean(
      postSearchResult?.searchSuccessful ?? postSearchResult?.runSuccessful,
    );
  } catch (err) {
    failureMessage = `Run failed: ${err.message}`;
    config.runtime.lastRunMessage = failureMessage;
    await set(config);
    diagnosticLog(`[INITIALISE] - Unexpected error: ${err.message}`, "error");
    recordCrash("initialise", err, {
      expectedSessionId,
      phase: config?.runtime?.currentPhase,
    });
  } finally {
    needPatch = false;
    diagnosticLog(
      `[RUN] Finished session ${expectedSessionId}: searches=${scheduleSucceeded}, activities/run=${runSucceeded}, phase=${config.runtime.currentPhase}, submitted=${config.runtime.done}, failed=${config.runtime.failed}${failureMessage ? `, error=${failureMessage}` : ""}.`,
      runSucceeded ? "success" : "warning",
    );
    if (!failureMessage && isSessionStillActive(expectedSessionId)) {
      config.runtime.lastRunMessage = runSucceeded
        ? ""
        : scheduleSucceeded
          ? "Searches completed. Rewards activities did not complete; check Microsoft login."
          : "Run finished without confirming all requested searches. Check Bing and retry.";
    }
    await cleanupAfterRun(tabId, expectedSessionId, {
      removeTabFn: (id) => chrome.tabs.remove(id),
      stopCurrentSession:
        RunCoordinator.stopCurrentSession.bind(RunCoordinator),
      setConfig: set,
      createAlarm: (name, opts) => chrome.alarms.create(name, opts),
      log: diagnosticLog,
      getConfig: () => config,
      isActiveSession: RunCoordinator.isActiveSession.bind(RunCoordinator),
      clearBadgeFn: () => chrome.action.setBadgeText({ text: "" }),
      runSucceeded: scheduleSucceeded,
      endedSessionType,
      getScheduleAlarmDelayMs,
      isScheduledModeActive: () => isScheduledModeActive(),
    });
    await flushDiagnosticLog(
      endedSessionType === "schedule" ? "schedule" : "run",
    );
  }

  return runSucceeded;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    const stored = await get();
    await applyStoredConfig(stored, "alarm");
    logs && log(`[ALARM] - Alarm triggered.`, "update");
    if (alarm.name === "schedule") {
      await tryStartScheduledRun("ALARM");
    } else if (alarm.name === "clear" || alarm.name === "clear_afternoon") {
      logs && log(`[ALARM] - ${alarm.name} alarm triggered.`, "update");
      const refreshed = await refreshSearchCountersFromRewards();
      if (!refreshed) {
        logs &&
          log(
            `[ALARM] - Rewards refresh failed; keeping previous counters as unknown.`,
            "warning",
          );
      }
      if (isScheduledModeActive()) {
        await tryStartScheduledRun("ALARM_CLEAR");
      } else if (config?.schedule?.mode === "m2") {
        logs &&
          log(
            `[ALARM] - Counter refreshed; m2 runs at startup only, not on timed alarms.`,
            "update",
          );
      }
    }
  } catch (error) {
    log(
      `[ALARM] - Error handling alarm ${alarm?.name}: ${error.message}`,
      "error",
    );
    recordCrash(`alarm:${alarm?.name || "unknown"}`, error);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.set({ mobile_points_enabled: true });
  await configReady;
  await bootstrapConfig();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get("mobile_points_enabled", (res) => {
    if (!res || !res.mobile_points_enabled) {
      chrome.storage.local.set({ mobile_points_enabled: true });
    }
  });
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const stored = await get();
    await applyStoredConfig(stored, "startup");
    log(`[STARTUP] - Extension started.`, "success");
    const isAtStartupMode = config?.schedule?.mode === "m2";
    if (isScheduledModeActive() || isAtStartupMode) {
      await delay(longestDelay, false);
      await tryStartScheduledRun("STARTUP");
    }
    const clearTime = new Date();
    clearTime.setHours(6, 0, 0, 0);
    if (clearTime < new Date()) {
      clearTime.setDate(clearTime.getDate() + 1);
    }
    await chrome.alarms.create("clear", {
      when: clearTime.getTime(),
      periodInMinutes: 24 * 60,
    });
    logs && log(`[STARTUP] - Clear alarm set for ${clearTime}.`, "update");

    // Secondary refresh alarm at 3 PM local — catches Rewards reset for Asian timezones
    const afternoonTime = new Date();
    afternoonTime.setHours(15, 0, 0, 0);
    if (afternoonTime < new Date()) {
      afternoonTime.setDate(afternoonTime.getDate() + 1);
    }
    await chrome.alarms.create("clear_afternoon", {
      when: afternoonTime.getTime(),
      periodInMinutes: 24 * 60,
    });
    logs &&
      log(
        `[STARTUP] - Afternoon refresh alarm set for ${afternoonTime}.`,
        "update",
      );
  } catch (error) {
    log(`[STARTUP] - Error during startup: ${error.message}`, "error");
    recordCrash("startup", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let responseSent = false;
  const reply = (payload) => {
    responseSent = true;
    sendResponse(payload);
  };
  (async () => {
    await configReady;
    const stored = await get();
    await applyStoredConfig(stored, `message:${message?.action || "unknown"}`);
    log(`Message received: ${message.action}`);

    switch (message.action) {
      case ACTIONS.START: {
        // Reject BEFORE mutating/persisting config, so a rejected start (because
        // another run is in progress) doesn't silently overwrite the search plan
        // or search counters.
        const startCheck = RunCoordinator.canStartNewRun();
        if (!startCheck.allowed) {
          log(
            `[MESSAGE] - Cannot start search. ${startCheck.reason}`,
            "warning",
          );
          reply({ success: false, message: "A run is already in progress." });
          return;
        }

        config.search = normalizeSearchPlan(message?.searches || config.search);
        await refreshSearchCountersFromRewards();

        const limitedSearchPlan = limitSearchPlanForToday(config.search, {
          silent: true,
        });
        if (!hasSearchWork(limitedSearchPlan) && !hasActivityWork()) {
          log("No searches or activities remaining for today.", "error");
          reply({
            success: false,
            message: "No searches or activities remaining for today.",
          });
          return;
        }

        const searchSession = RunCoordinator.startNewSession("search");
        if (!searchSession) {
          reply({ success: false, message: "Failed to start session." });
          return;
        }

        config.runtime.lastRunMessage = "Starting searches.";
        await set(config);

        const startLabel = hasSearchWork(limitedSearchPlan)
          ? `${limitedSearchPlan.desk} desktop and ${limitedSearchPlan.mob} mobile`
          : "activities only";
        log(`Starting searches: ${startLabel}. (session: ${searchSession.id})`);
        reply({ success: true, message: "Starting searches." });

        await initialise(config?.search, searchSession.id);
        break;
      }

      case ACTIONS.SCHEDULE: {
        // Check before persisting a plan or arming an alarm. A rejected command
        // must leave the schedule and the active run unchanged.
        const scheduleCheck = RunCoordinator.canStartNewRun();
        if (!scheduleCheck.allowed) {
          log(
            `[MESSAGE] - Cannot start schedule. ${scheduleCheck.reason}`,
            "warning",
          );
          reply({ success: false, message: "A run is already in progress." });
          return;
        }

        config.schedule = normalizeSearchPlan(
          message?.searches || config.schedule,
        );
        if (config?.schedule?.mode) {
          const m = config.schedule.mode.match(/m[1-4]/);
          if (m) config.schedule.mode = m[0];
        }
        await set(config);

        if (config?.schedule?.desk === 0 && config?.schedule?.mob === 0) {
          await chrome.alarms.clear("schedule");
          log("No searches to schedule.", "error");
          reply({ success: false, message: "No searches to schedule." });
          return;
        }

        if (["m3", "m4"].includes(config?.schedule?.mode)) {
          await armScheduleAlarm(config.schedule.mode);
          logs &&
            log(
              `[MESSAGE] - Schedule armed for mode ${config.schedule.mode}; starting searches now.`,
              "update",
            );
        } else {
          await chrome.alarms.clear("schedule");
        }

        const scheduleSession = RunCoordinator.startNewSession("schedule");
        if (!scheduleSession) {
          reply({
            success: false,
            message: "Failed to start schedule session.",
          });
          return;
        }

        config.runtime.lastRunMessage = "Starting scheduled searches.";
        await set(config);

        const scheduleLabel = `${config.schedule.desk} desktop and ${config.schedule.mob} mobile`;
        log(
          `Starting scheduled searches: ${scheduleLabel}. (session: ${scheduleSession.id})`,
        );
        reply({ success: true, message: "Starting scheduled searches." });

        await initialise(config?.schedule, scheduleSession.id);
        break;
      }

      case ACTIONS.STOP:
        log("Stopping searches or activities.");
        await handleUserStop();
        reply({
          success: true,
          message: "Stopping searches or activities.",
        });
        break;

      case ACTIONS.CLEAR_BROWSING_DATA: {
        log("Clearing Bing browsing data.");
        const cleared = await clear(false, true);
        reply({
          success: cleared,
          message: cleared
            ? "Bing browsing data cleared."
            : "Failed to clear Bing browsing data.",
        });
        break;
      }

      case ACTIONS.SIMULATE: {
        log("Toggling mobile device simulation.");
        const simulated = await toggleSimulate();
        reply({
          success: simulated,
          message: simulated
            ? "Mobile device simulation toggled."
            : "Failed to toggle mobile device simulation.",
        });
        break;
      }

      case ACTIONS.ACTIVITY: {
        log("Starting activity.");
        const activityCheck = RunCoordinator.canStartNewRun();
        if (!activityCheck.allowed) {
          reply({ success: false, message: "A run is already in progress." });
          return;
        }
        if (!navigator.onLine) {
          config.runtime.lastRunMessage =
            "Activities could not start: Chrome is offline. Check your internet connection.";
          await set(config);
          reply({ success: false, message: config.runtime.lastRunMessage });
          return;
        }

        const activitySession = RunCoordinator.startNewSession("activity");
        if (!activitySession) {
          reply({
            success: false,
            message: "Failed to start activity session.",
          });
          return;
        }

        config.runtime.lastRunMessage = "Starting Rewards activities.";
        await set(config);
        reply({
          success: true,
          message: "Starting activity.",
        });

        let activityTab = null;
        try {
          activityTab = await chrome.tabs.create({
            url: rewards + "dashboard",
            active: true,
          });
          if (!RunCoordinator.isActiveSession(activitySession.id)) return;
          config.runtime.rsaTab = activityTab.id;
          await set(config);
          await wait(activityTab.id);
          await activity(activityTab.id, true, {
            recordRun: false,
            expectedSessionId: activitySession.id,
          });
        } catch (error) {
          if (RunCoordinator.isActiveSession(activitySession.id)) {
            config.runtime.lastRunMessage = `Activities failed: ${error.message}`;
            await set(config);
          }
          throw error;
        } finally {
          if (activityTab?.id) {
            try {
              await chrome.tabs.remove(activityTab.id);
            } catch (error) {
              logs &&
                log(
                  `[MESSAGE] Failed to close activity tab: ${error.message}`,
                  "warning",
                );
            }
          }
          if (RunCoordinator.isActiveSession(activitySession.id)) {
            await RunCoordinator.stopCurrentSession("activity_finish");
          }
          await flushDiagnosticLog("activity");
        }
        break;
      }

      default:
        log(`Unknown message action: ${message.action}`, "error");
        reply({
          success: false,
          message: "Unknown message action.",
        });
        break;
    }
  })().catch((error) => {
    log(
      `[MESSAGE] Error handling ${message?.action || "unknown"}: ${error.message}`,
      "error",
    );
    recordCrash(`message:${message?.action || "unknown"}`, error);
    if (!responseSent) {
      reply({
        success: false,
        message: error.message,
      });
    }
  });
  return true;
});
