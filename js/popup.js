import "/js/jquery.js";
import { log, get, atomicUpdate, applyConfigDefaults } from "/js/utils.js";
import { devices } from "/js/devices.js";
import { createDefaultConfig } from "/js/config-defaults.js";
import { ACTIONS, MESSAGE_TIMEOUT_MS } from "/js/messages.js";
import { exportCrashLogText, clearCrashLog } from "/js/crash-logger.js";

/**
 * Send a message to the service worker but never hang forever if the worker is
 * asleep or drops the response. Rejects after MESSAGE_TIMEOUT_MS so callers'
 * catch blocks can flash a failure instead of leaving a button stuck.
 */
function sendMessageWithTimeout(message, timeoutMs = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`No response from service worker after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.runtime.sendMessage(message).then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
let config = createDefaultConfig();
let _uiUpdateTimer = null;
let _uiLocked = false;
let commandStatus = "";
let lastWorkerStatus = "";

function showRunStatus(message) {
  commandStatus = message || "";
  $(".runStatus").text(commandStatus).prop("hidden", !commandStatus);
}

// ── Tunables (were magic numbers scattered through the file) ──
const UI_UPDATE_DEBOUNCE_MS = 80;
const STATUS_FLASH_MS = 1000;
const STOP_WAIT_TIMEOUT_MS = 15000;
const STOP_WAIT_POLL_MS = 100;
// Desktop/Mobile count presets shared by the "mode" buttons and compare().
const SEARCH_MODE_PRESETS = {
  m1: { desk: 1, mob: 0 },
  m2: { desk: 0, mob: 1 },
  m3: { desk: 0, mob: 21 },
  m4: { desk: 0, mob: 0 },
};

function scheduleUIUpdate() {
  if (_uiLocked) return;
  if (_uiUpdateTimer) clearTimeout(_uiUpdateTimer);
  _uiUpdateTimer = setTimeout(async () => {
    _uiUpdateTimer = null;
    if (!_uiLocked) await updateUI();
  }, UI_UPDATE_DEBOUNCE_MS);
}
const limitsMap = {
  searchDesk: { min: 0, max: [100, 300] },
  searchMob: { min: 0, max: [100, 300] },
  searchMin: { min: 7, max: [60, 600] },
  searchMax: { min: 14, max: [90, 900] },
  scheduleDesk: { min: 0, max: [100, 300] },
  scheduleMob: { min: 0, max: [100, 300] },
  scheduleMin: { min: 7, max: [60, 600] },
  scheduleMax: { min: 14, max: [90, 900] },
};
const $nav = $(".nav");
const $section = $("section");
$nav.on("click", (event) => {
  event.preventDefault();
  const logs = config?.control?.log;
  $nav.removeClass("active");
  $(event.currentTarget).addClass("active");
  $nav.removeAttr("aria-current");
  $(event.currentTarget).attr("aria-current", "page");
  $section.attr("hidden", true);
  const sectionId = $(event.currentTarget).data("open");
  $(`#${sectionId}`).removeAttr("hidden").show();
  logs && log(`[NAV] - Section changed to: ${sectionId}`);
});
const $searchDesk = $("#searchDesk");
const $searchMob = $("#searchMob");
const $searchMin = $("#searchMin");
const $searchMax = $("#searchMax");
const $searchMode = $("#searchMode");
const $searchModeA = $("#searchMode a");
const $searchTrigger = $("#searchTrigger");
const $scheduleDesk = $("#scheduleDesk");
const $scheduleMob = $("#scheduleMob");
const $scheduleMin = $("#scheduleMin");
const $scheduleMax = $("#scheduleMax");
const $scheduleMode = $("#scheduleMode");
const $scheduleModeA = $("#scheduleMode a");
const $scheduleTrigger = $("#scheduleTrigger");
const $version = $("#version");
const $userManual = $("#userManual");
const $deviceName = $("#deviceName");
const $resetDevice = $("#resetDevice");
const $clear = $("#clear");
const $log = $("#log");
const $niche = $("#niche");
const $activity = $("#activity");
const $act = $("#act");
const $clearBrowsingData = $("#clearBrowsingData");
const $simulate = $("#simulate");
const $download = $("#download");
const $delete = $("#delete");
const $downloadCrashLog = $("#downloadCrashLog");
const $clearCrashLog = $("#clearCrashLog");
const $runtime = $("#runtime");
const $reset = $("#reset");
const $progressBar = $(".progressBar");
const $progress = $(".progress:not(.act)");
const $failed = $(".failed");
function compare() {
  const logs = config?.control?.log;
  const desk = Number($searchDesk.val());
  const mob = Number($searchMob.val());
  $searchModeA.removeClass("active");
  let matchedMode = null;
  for (const [id, val] of Object.entries(SEARCH_MODE_PRESETS)) {
    if (desk === val.desk && mob === val.mob) {
      $searchMode.find(`a.${id}`).addClass("active");
      logs && log(`[COMPARE] - Search mode set to: ${id}`, "update");
      config.search.mode = id;
      $searchMode.val(id);
      matchedMode = id;
      break;
    }
  }
  if (!matchedMode) {
    config.search.mode = "custom";
    $searchMode.val("custom");
    logs && log(`[COMPARE] - Search mode set to custom values.`, "update");
  }
}
async function saveConfigMutation(mutator) {
  const updated = await atomicUpdate((stored) => {
    const next = createDefaultConfig();
    applyConfigDefaults(next, stored);
    mutator(next);
    return next;
  });
  config = updated || config;
  return config;
}
async function resetDevice() {
  const logs = config?.control?.log;
  try {
    const randomDevice = devices[Math.floor(Math.random() * devices.length)];
    await saveConfigMutation((next) => {
      next.device.name = randomDevice.name;
      next.device.ua = randomDevice.userAgent;
      next.device.h = randomDevice.height;
      next.device.w = randomDevice.width;
      next.device.scale = randomDevice.deviceScaleFactor;
    });
    logs &&
      log(
        `[RESET] - Device reset to: ${JSON.stringify(config.device.name)}`,
        "success",
      );
    return true;
  } catch (error) {
    logs && log(`[RESET] - Error resetting device: ${error?.message}`, "error");
    return false;
  }
}
async function updateUI() {
  const storedConfig = await get();
  applyConfigDefaults(config, storedConfig);
  const logs = config?.control?.log;
  for (const [key, limits] of Object.entries(limitsMap)) {
    const $el = $(`#${key}`);
    $el.attr("min", limits.min);
    $el.attr("max", limits.max[1]);
  }
  $searchDesk.val(config.search.desk);
  $searchMob.val(config.search.mob);
  $searchMin.val(config.search.min);
  $searchMax.val(config.search.max);
  compare();
  $scheduleDesk.val(config.schedule.desk);
  $scheduleMob.val(config.schedule.mob);
  $scheduleMin.val(config.schedule.min);
  $scheduleMax.val(config.schedule.max);
  $scheduleModeA.removeClass("active");
  $scheduleMode.find(`.${config.schedule.mode}`).addClass("active");
  const isRunning = Boolean(config?.runtime?.running);
  const activeMode = config?.runtime?.mode;
  const isSearchRun = isRunning && activeMode === "search";
  const isScheduleRun = isRunning && activeMode === "schedule";
  const isActivityRun = isRunning && activeMode === "activity";
  $searchTrigger.text(isSearchRun ? "Stop" : "Search");
  $scheduleTrigger.text(isScheduleRun ? "Stop" : "Schedule");
  $searchTrigger.prop("disabled", isRunning && !isSearchRun);
  $scheduleTrigger.prop("disabled", isRunning && !isScheduleRun);
  $activity.text(isActivityRun ? "Stop" : "Perform");
  $activity.prop("disabled", isRunning && !isActivityRun);
  const { total, done, failed } = config.runtime;
  const totalCount = Number(total) || 0;
  const doneCount = Number(done) || 0;
  const failedCount = Number(failed) || 0;
  const success = doneCount;
  // Guard division explicitly instead of relying on isFinite() to catch 0/0.
  const percent = (part) =>
    totalCount > 0 ? ((part / totalCount) * 100).toFixed(2) : "0.00";
  const performedPercent = percent(doneCount);
  const successPercent = percent(success);
  const failedPercent = percent(failedCount);
  const progressPercent = percent(success + failedCount);
  $progressBar
    .parent()
    .attr(
      "title",
      `Total: ${totalCount}, Performed: ${doneCount} - (${performedPercent}%), Success: ${success} - (${successPercent}%), Failed: ${failedCount} - (${failedPercent}%) - Progress: ${progressPercent}%`,
    );
  $progress.width(totalCount ? (success / totalCount) * 100 + "%" : "0%");
  $failed.width(totalCount ? (failedCount / totalCount) * 100 + "%" : "0%");
  // Display only — never write storage during a render pass. Picking an initial
  // device happens once at startup (see $(document).ready).
  $deviceName.text(config?.device?.name || "");
  $clear.prop("checked", config?.control?.clear);
  // Hide the completion text also when it was saved by an older worker.
  const workerStatus =
    config.runtime.lastRunMessage === "Run completed."
      ? ""
      : config.runtime.lastRunMessage || "";
  if (workerStatus !== lastWorkerStatus) {
    lastWorkerStatus = workerStatus;
    commandStatus = workerStatus;
  }
  $(".runStatus").text(commandStatus).prop("hidden", !commandStatus);
  $log.prop("checked", config?.control?.log);
  const storedNiche = config?.control?.niche || "random";
  const validNiches = $niche
    .find("option")
    .map((_, el) => $(el).val())
    .get();
  const resolvedNiche = validNiches.includes(storedNiche)
    ? storedNiche
    : "random";
  // Render is read-only — do NOT persist here. An unknown niche is harmless
  // (the service worker already falls back to a random category), so we just
  // display the fallback without writing storage during a render pass.
  if (resolvedNiche !== storedNiche) {
    logs &&
      log(
        `[CONTROL] - Unknown niche "${storedNiche}"; showing random as fallback.`,
        "warning",
      );
  }
  $niche.val(resolvedNiche);
  $act.prop("checked", config?.control?.act ? true : false);
  if (config.runtime.act) {
    $("#activity ~ .progressBar > .progress").addClass("running");
  } else {
    $("#activity ~ .progressBar > .progress").removeClass("running");
  }

  const configInputIds = [
    "#searchDesk",
    "#searchMob",
    "#searchMin",
    "#searchMax",
    "#scheduleDesk",
    "#scheduleMob",
    "#scheduleMin",
    "#scheduleMax",
  ];

  configInputIds.forEach((id) => {
    $(id).prop("disabled", isRunning);
  });

  $("#searchMode a, #scheduleMode a").toggleClass("disabled", isRunning);

  // Disable maintenance actions that would corrupt or collide with an active
  // run (start another activity/simulation, or wipe cookies mid-run).
  $("#simulate, #clearBrowsingData").prop("disabled", isRunning);

  logs && log(`[UPDATE] - UI updated`, "update");
}
async function flashStatus($btn, originalText, result) {
  // Remember the button's original tooltip so we can restore it after the flash
  // (rather than wiping the useful HTML title on success, or leaving a stale
  // error title stuck forever on failure).
  const originalTitle = $btn.attr("title");
  $btn.removeClass("flash-success flash-failed");
  showRunStatus(
    result?.message ||
      (result === true || result?.success
        ? ""
        : "Action failed. Please try again."),
  );
  if (result?.success || result === true) {
    $btn.addClass("flash-success").text("Success!");
  } else {
    $btn.addClass("flash-failed").text("Failed!");
    // Surface the reason from the service worker instead of swallowing it: show
    // it as a hover tooltip and always echo it to the console (independent of
    // the "Advanced logs" toggle, which is off by default).
    const reason = result?.message;
    if (reason) {
      $btn.attr("title", reason);
      console.warn(`[STATUS] ${originalText} failed: ${reason}`);
    }
  }
  await new Promise((r) => setTimeout(r, STATUS_FLASH_MS));
  $btn.removeClass("flash-success flash-failed").text(originalText);
  if (originalTitle == null) $btn.removeAttr("title");
  else $btn.attr("title", originalTitle);
}
async function stopActiveRunIfNeeded() {
  const stored = await get();
  if (!stored?.runtime?.running) return true;
  // The worker may be asleep; if the stop message is lost we still poll storage
  // below, so swallow send errors rather than aborting the reset flow.
  try {
    await sendMessageWithTimeout({ action: ACTIONS.STOP });
  } catch (err) {
    config?.control?.log &&
      log(`[STOP] - Stop message failed: ${err?.message || err}`, "warning");
  }
  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await get();
    if (!current?.runtime?.running) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_POLL_MS));
  }
  return false;
}

function dedupeHistoryEntries(entries) {
  const seen = new Set();
  const deduped = [];
  for (const item of entries) {
    const key = `${item.url}|${item.lastVisitTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function fetchBingHistoryLast24Hours() {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const pageSize = 1000;
  const maxEntries = 10000;
  const allResults = [];
  const excludedIds = new Set();
  let lastVisitTime = Date.now();

  while (allResults.length < maxEntries) {
    const page = await new Promise((resolve, reject) => {
      chrome.history.search(
        {
          text: "bing.com",
          startTime: oneDayAgo,
          endTime: lastVisitTime,
          maxResults: pageSize,
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(results || []);
        },
      );
    });

    const freshPage = page.filter((item) => !excludedIds.has(item.id));
    if (!freshPage.length) break;
    allResults.push(...freshPage);
    if (page.length < pageSize) break;

    const oldest = freshPage.reduce(
      (min, item) => (item.lastVisitTime < min ? item.lastVisitTime : min),
      freshPage[0].lastVisitTime,
    );
    if (!oldest || oldest <= oneDayAgo) break;

    const sameTimestampCount = freshPage.filter(
      (item) => item.lastVisitTime === oldest,
    ).length;
    if (sameTimestampCount === freshPage.length) {
      freshPage.forEach((item) => excludedIds.add(item.id));
      lastVisitTime = oldest;
      continue;
    }

    lastVisitTime = oldest - 1;
  }

  return dedupeHistoryEntries(allResults);
}

function clampLimitedNumber(raw, limitKey) {
  const entry = limitsMap[limitKey];
  if (!entry) return Number(raw) || 0;
  const { min, max } = entry;
  const maxVal = max[1];
  const num = Number(raw);
  if (isNaN(num)) return min;
  return Math.max(min, Math.min(maxVal, num));
}
function readLimitedNumber($el, limitKey) {
  return clampLimitedNumber($el.val(), limitKey);
}
async function persistSearchForm() {
  const min = readLimitedNumber($searchMin, "searchMin");
  const max = Math.max(min, readLimitedNumber($searchMax, "searchMax"));
  const searches = {
    ...(config.search || {}),
    desk: readLimitedNumber($searchDesk, "searchDesk"),
    mob: readLimitedNumber($searchMob, "searchMob"),
    min,
    max,
  };
  await saveConfigMutation((next) => {
    next.search = { ...next.search, ...searches };
  });
  return { ...config.search };
}
async function persistScheduleForm() {
  const min = readLimitedNumber($scheduleMin, "scheduleMin");
  const max = Math.max(min, readLimitedNumber($scheduleMax, "scheduleMax"));
  const searches = {
    ...(config.schedule || {}),
    desk: readLimitedNumber($scheduleDesk, "scheduleDesk"),
    mob: readLimitedNumber($scheduleMob, "scheduleMob"),
    min,
    max,
  };
  await saveConfigMutation((next) => {
    next.schedule = { ...next.schedule, ...searches };
  });
  return { ...config.schedule };
}
$(document).ready(async function () {
  $section.attr("hidden", true);
  $("#search").removeAttr("hidden").show();
  $version.val(chrome.runtime.getManifest().version);
  $userManual.on("click", () => {
    chrome.tabs.create({
      url: "/Rewards Search Automator User Manual.pdf",
    });
  });

  const scale = Math.min(screen.width, screen.height * (16 / 9)) / 1920;
  $("body").css("--scale", `${scale}`);
  await updateUI();

  // Pick a random simulated device once if none is stored yet, then re-render.
  if (!config?.device?.name) {
    await resetDevice();
    $deviceName.text(config?.device?.name || "");
  }

  chrome.storage.sync
    .get("user_stat_uuid")
    .then((data) => {
      $("#uuid").val(data?.user_stat_uuid || "");
    })
    .catch(() => {});
  $("#uuid").on("click", function () {
    this.select();
    document.execCommand("copy");
  });

  const logs = config?.control?.log;
  logs && log("[INIT] - UI initialized with scale: " + scale, "update");
  $searchDesk.on("change", async function () {
    const desk = readLimitedNumber($(this), "searchDesk");
    await saveConfigMutation((next) => {
      next.search.desk = desk;
    });
  });
  $searchMob.on("change", async function () {
    const mob = readLimitedNumber($(this), "searchMob");
    await saveConfigMutation((next) => {
      next.search.mob = mob;
    });
  });
  $searchMin.on("change", async function () {
    let val = readLimitedNumber($(this), "searchMin");
    let range = Number($searchMax.val());
    const patch = { min: val };
    if (range < val * 1.5) {
      range = clampLimitedNumber(Math.ceil(val * 1.5), "searchMax");
      patch.max = range;
    }
    await saveConfigMutation((next) => {
      Object.assign(next.search, patch);
    });
  });
  $searchMax.on("change", async function () {
    let val = readLimitedNumber($(this), "searchMax");
    let range = Number($searchMin.val());
    const patch = { max: val };
    if (val < range * 1.5) {
      range = clampLimitedNumber(Math.floor(val / 1.5), "searchMin");
      patch.min = range;
    }
    await saveConfigMutation((next) => {
      Object.assign(next.search, patch);
    });
  });
  $searchModeA.on("click", async function () {
    const mode = ($(this).attr("class") || "")
      .split(/\s+/)
      .find((c) => /^m\d$/.test(c));
    const preset = SEARCH_MODE_PRESETS[mode];
    if (preset) {
      await saveConfigMutation((next) => {
        next.search.desk = preset.desk;
        next.search.mob = preset.mob;
      });
    }
  });
  $scheduleDesk.on("change", async function () {
    const desk = readLimitedNumber($(this), "scheduleDesk");
    await saveConfigMutation((next) => {
      next.schedule.desk = desk;
    });
  });
  $scheduleMob.on("change", async function () {
    const mob = readLimitedNumber($(this), "scheduleMob");
    await saveConfigMutation((next) => {
      next.schedule.mob = mob;
    });
  });
  $scheduleMin.on("change", async function () {
    let val = readLimitedNumber($(this), "scheduleMin");
    let range = Number($scheduleMax.val());
    const patch = { min: val };
    if (range < val * 1.5) {
      range = clampLimitedNumber(Math.ceil(val * 1.5), "scheduleMax");
      patch.max = range;
    }
    await saveConfigMutation((next) => {
      Object.assign(next.schedule, patch);
    });
  });
  $scheduleMax.on("change", async function () {
    let val = readLimitedNumber($(this), "scheduleMax");
    let range = Number($scheduleMin.val());
    const patch = { max: val };
    if (val < range * 1.5) {
      range = clampLimitedNumber(Math.floor(val / 1.5), "scheduleMin");
      patch.min = range;
    }
    await saveConfigMutation((next) => {
      Object.assign(next.schedule, patch);
    });
  });
  $scheduleModeA.on("click", async function () {
    const mode = ($(this).attr("class") || "")
      .split(/\s+/)
      .find((c) => /^m\d$/.test(c));
    if (!mode) return;
    // NOTE: These buttons only control run frequency (Manual/Startup/~5min/~15min).
    // They must not silently overwrite the Desktop/Mobile counts the user already set.
    await saveConfigMutation((next) => {
      next.schedule.mode = mode;
    });
    logs && log(`[SCHEDULE] - Schedule mode selected: ${mode}`, "update");
  });
  // Search and Schedule triggers share identical start/stop plumbing; only the
  // start action, the form to persist, and the log label differ.
  function makeRunTriggerHandler({ startAction, persistForm, logTag, label }) {
    return async function () {
      const $btn = $(this);
      if (_uiLocked || $btn.prop("disabled")) return;

      const originalText = $btn.text();
      $btn.prop("disabled", true);
      _uiLocked = true;

      try {
        if (config?.runtime?.running) {
          $btn.text("Stopping...");
          const response = await sendMessageWithTimeout({
            action: ACTIONS.STOP,
          });
          await flashStatus($btn, originalText, response);
          logs &&
            log(`[${logTag}] - ${label} stopped: ${originalText}`, "update");
        } else {
          $btn.text("Starting...");
          const message = { action: startAction };
          if (persistForm) message.searches = await persistForm();
          const response = await sendMessageWithTimeout(message);
          await flashStatus($btn, originalText, response);
          logs &&
            log(`[${logTag}] - ${label} started: ${originalText}`, "update");
        }
      } catch (err) {
        logs &&
          log(
            `[${logTag}] Click handler error: ${err?.message || err}`,
            "error",
          );
        await flashStatus($btn, originalText, {
          success: false,
          message: err?.message || String(err),
        });
      } finally {
        _uiLocked = false;
        $btn.prop("disabled", false);
        await updateUI();
      }
    };
  }
  $searchTrigger.on(
    "click",
    makeRunTriggerHandler({
      startAction: ACTIONS.START,
      persistForm: persistSearchForm,
      logTag: "SEARCH",
      label: "Search",
    }),
  );
  $scheduleTrigger.on(
    "click",
    makeRunTriggerHandler({
      startAction: ACTIONS.SCHEDULE,
      persistForm: persistScheduleForm,
      logTag: "SCHEDULE",
      label: "Schedule",
    }),
  );
  $resetDevice.on("click", async function () {
    await resetDevice();
    logs && log(`[DEVICE] - Device reset`, "update");
  });
  $clear.on("change", async function () {
    const clear = $(this).is(":checked") ? 1 : 0;
    await saveConfigMutation((next) => {
      next.control.clear = clear;
    });
    logs &&
      log(
        `[CONTROL] - Clear browsing data set to: ${config.control.clear}`,
        "update",
      );
  });
  $log.on("change", async function () {
    const enableLog = $(this).is(":checked") ? 1 : 0;
    await saveConfigMutation((next) => {
      next.control.log = enableLog;
    });
    logs && log(`[CONTROL] - Log enabled: ${config.control.log}`, "update");
  });
  $niche.on("change", async function () {
    const niche = $(this).val().trim() || "random";
    await saveConfigMutation((next) => {
      next.control.niche = niche;
    });
    logs && log(`[CONTROL] - Niche set to: ${config.control.niche}`, "update");
  });
  $activity.on(
    "click",
    makeRunTriggerHandler({
      startAction: ACTIONS.ACTIVITY,
      logTag: "ACTIVITY",
      label: "Activity",
    }),
  );
  $act.on("change", async function () {
    const act = $(this).is(":checked") ? 1 : 0;
    await saveConfigMutation((next) => {
      next.control.act = act;
    });
    logs && log(`[CONTROL] - Act set to: ${config.control.act}`, "update");
  });
  $clearBrowsingData.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    _uiLocked = true;
    try {
      const response = await sendMessageWithTimeout({
        action: ACTIONS.CLEAR_BROWSING_DATA,
      });
      await flashStatus($btn, $btnText, response);
      logs &&
        log(
          `[CLEAR BROWSING DATA] - Data cleared: ${response?.message ?? JSON.stringify(response)}`,
          "update",
        );
    } catch (err) {
      await flashStatus($btn, $btnText, false);
    } finally {
      _uiLocked = false;
      $btn.prop("disabled", false);
    }
  });
  $simulate.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    _uiLocked = true;
    try {
      const response = await sendMessageWithTimeout({
        action: ACTIONS.SIMULATE,
      });
      await flashStatus($btn, $btnText, response);
      logs &&
        log(
          `[SIMULATE] - Simulation started: ${response?.message ?? JSON.stringify(response)}`,
          "update",
        );
    } catch (err) {
      await flashStatus($btn, $btnText, false);
    } finally {
      _uiLocked = false;
      $btn.prop("disabled", false);
    }
  });
  $download.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    try {
      const results = await fetchBingHistoryLast24Hours();
      const blob = new Blob([JSON.stringify(results, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `[Rewards_Search_Automator]_bing_search_history_${new Date().toISOString()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      a.remove();
      await flashStatus($btn, $btnText, true);
      logs &&
        log(
          `[DOWNLOAD] - Search history downloaded: ${results.length} entries`,
          "update",
        );
    } catch (error) {
      await flashStatus($btn, $btnText, false);
      log(
        `[DOWNLOAD] - Error downloading search history: ${error?.message}`,
        "error",
      );
    } finally {
      $btn.prop("disabled", false);
    }
  });
  $delete.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    try {
      const results = await fetchBingHistoryLast24Hours();
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const uniqueUrls = [
        ...new Set(results.map((item) => item.url).filter(Boolean)),
      ];
      for (const url of uniqueUrls) {
        await new Promise((resolve, reject) => {
          chrome.history.deleteUrl({ url }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve();
          });
        });
      }
      await flashStatus($btn, $btnText, true);
      logs &&
        log(
          `[DELETE] - Removed ${uniqueUrls.length} Bing URLs from history (last 24h window: ${oneDayAgo}-${Date.now()}). Older visits for the same URLs may also be removed by Chrome.`,
          "update",
        );
    } catch (error) {
      await flashStatus($btn, $btnText, false);
      log(
        `[DELETE] - Error deleting search history: ${error?.message}`,
        "error",
      );
    } finally {
      $btn.prop("disabled", false);
    }
  });
  $downloadCrashLog.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    try {
      const text = await exportCrashLogText();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `[Rewards_Search_Automator]_crash_log_${new Date().toISOString()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      a.remove();
      await flashStatus($btn, $btnText, true);
      logs && log(`[CRASH LOG] - Crash log downloaded.`, "update");
    } catch (error) {
      await flashStatus($btn, $btnText, false);
      log(
        `[CRASH LOG] - Error downloading crash log: ${error?.message}`,
        "error",
      );
    } finally {
      $btn.prop("disabled", false);
    }
  });
  $clearCrashLog.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    try {
      await clearCrashLog();
      await flashStatus($btn, $btnText, true);
      logs && log(`[CRASH LOG] - Crash log cleared.`, "update");
    } catch (error) {
      await flashStatus($btn, $btnText, false);
      log(`[CRASH LOG] - Error clearing crash log: ${error?.message}`, "error");
    } finally {
      $btn.prop("disabled", false);
    }
  });
  $runtime.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    try {
      const stopped = await stopActiveRunIfNeeded();
      if (!stopped) {
        await flashStatus($btn, $btnText, false);
        log(`[RUNTIME] - Stop timed out; runtime not reset.`, "error");
        return;
      }
      await saveConfigMutation((next) => {
        next.runtime.done = 0;
        next.runtime.total = 0;
        next.runtime.failed = 0;
        next.runtime.mobile = 0;
        next.runtime.act = 0;
        next.runtime.running = 0;
        next.runtime.mode = null;
        next.runtime.currentSession = null;
        next.runtime.currentPhase = null;
        next.runtime.rsaTab = null;
      });
      await flashStatus($btn, $btnText, true);
      logs && log(`[RUNTIME] - Runtime reset.`, "update");
    } finally {
      $btn.prop("disabled", false);
    }
  });
  $reset.on("click", async function () {
    const $btn = $(this);
    if ($btn.prop("disabled")) return;
    const $btnText = $btn.text();
    $btn.prop("disabled", true);
    const stopped = await stopActiveRunIfNeeded();
    if (!stopped) {
      await flashStatus($btn, $btnText, false);
      log(`[RESET] - Stop timed out; extension not reset.`, "error");
      $btn.prop("disabled", false);
      return;
    }
    await chrome.storage.local.remove("config");
    await flashStatus($btn, $btnText, true);
    logs && log(`[RESET] - Extension config reset.`, "update");
    location.reload();
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.config || changes.activityMemory)) {
    scheduleUIUpdate();
  }
});
