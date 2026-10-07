"use strict";

// Execute the extension's real ESM graph, including Chrome-style /js imports.
// Run in a child Node process with --experimental-vm-modules; browser APIs are
// mocked, but imports, storage bootstrap, messages and alarms are real code.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.resolve(__dirname, "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) =>
      Promise.all([...listeners].map((listener) => listener(...args))),
    listeners,
  };
}

async function bootWorker(options = {}) {
  const storageChanged = event();
  const store = {};
  const tabsCreated = [];
  const tabsRemoved = [];
  const alarms = new Map();
  const timers = new Map();
  const pendingRewardsReads = [];
  const debuggerCommands = [];
  const browsingDataCalls = [];
  const diagnosticDownloads = [];
  const attachedTabs = new Set();
  let fetchCalls = 0;
  let nextTimer = 0;
  const scheduleTimer = (fn) => {
    const id = ++nextTimer;
    timers.set(id, fn);
    return id;
  };
  const chrome = {
    runtime: {
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      getURL: (url) => `chrome-extension://test${url}`,
      getManifest: () =>
        JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")),
    },
    storage: {
      onChanged: storageChanged,
      local: {
        get: (key, callback) => {
          const data =
            key == null
              ? clone(store)
              : { [key]: store[key] && clone(store[key]) };
          callback?.(data);
          return Promise.resolve(data);
        },
        set: (patch, callback) => {
          Object.assign(store, clone(patch));
          if (patch.config)
            void storageChanged.emit(
              { config: { newValue: clone(patch.config) } },
              "local",
            );
          callback?.();
          return Promise.resolve();
        },
        remove: (key) => {
          delete store[key];
          return Promise.resolve();
        },
      },
    },
    alarms: {
      onAlarm: event(),
      get: async (name) => alarms.get(name),
      create: async (name, alarm) => {
        alarms.set(name, clone(alarm));
      },
      clear: async (name) => alarms.delete(name),
    },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      create: async (tab) => {
        const created = { ...tab, id: tabsCreated.length + 1 };
        tabsCreated.push(created);
        return created;
      },
      // Keep tabs loading until a test emits completion. Other operations (like
      // detach during Stop) must still be able to read the tab URL.
      get: async (id) => ({
        ...(tabsCreated.find((tab) => tab.id === id) || {
          id,
          url: "https://www.bing.com/",
        }),
        status:
          options.finishEmptyActivity || options.mobilePatchProbe
            ? "complete"
            : "loading",
      }),
      remove: async (id) => {
        tabsRemoved.push(id);
      },
      query: async () => [],
      update: async (id, patch) => {
        const tab = tabsCreated.find((tab) => tab.id === id);
        if (tab) Object.assign(tab, patch);
        return { id, ...patch };
      },
      sendMessage: async () => ({ success: true, active: true }),
    },
    debugger: {
      onDetach: event(),
      attach: async (target) => attachedTabs.add(target.tabId),
      detach: async (target) => attachedTabs.delete(target.tabId),
      getTargets: async () =>
        [...attachedTabs].map((tabId) => ({
          type: "page",
          tabId,
          attached: true,
        })),
      sendCommand: async (target, command, params) => {
        debuggerCommands.push({ tabId: target.tabId, command });
        return (options.activityPassProbe || options.finishEmptyActivity) &&
          command === "Runtime.evaluate"
          ? {
              result: {
                value: {
                  clicked: params?.expression?.includes("const readyPattern")
                    ? false
                    : [],
                  skipped: [{ reason: "already done" }],
                  retry: false,
                },
              },
            }
          : {};
      },
    },
    webNavigation: { onCommitted: event() },
    cookies: {
      getAll: async () => [],
      get: async () => null,
      set: async () => ({}),
    },
    browsingData: {
      remove: async (details, data) => {
        browsingDataCalls.push({ details, data });
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    downloads: {
      download: async ({ url }) => {
        diagnosticDownloads.push(
          decodeURIComponent(url.split(",").slice(1).join(",")),
        );
        return 1;
      },
    },
  };
  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    AbortController,
    navigator: {
      onLine: options.online !== false,
      locks: { request: async (_name, _opts, fn) => fn() },
    },
    self: { addEventListener() {} },
    setTimeout: scheduleTimer,
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer,
    clearInterval() {},
    fetch: async () => {
      fetchCalls++;
      if (options.finishEmptyActivity)
        return {
          ok: true,
          json: async () => ({
            status: { userStatus: { availablePoints: 42 } },
          }),
        };
      if (options.pauseRewardsSession) {
        return new Promise((resolve) => pendingRewardsReads.push(resolve));
      }
      throw new Error("No Microsoft account/network in test profile");
    },
  });
  const modules = new Map();
  const load = (specifier) => {
    const file = path.join(root, specifier.replace(/^\//, ""));
    if (!modules.has(file)) {
      modules.set(
        file,
        new vm.SourceTextModule(
          fs.readFileSync(file, "utf8") +
            (options.activityPassProbe &&
            file === path.join(root, "js/service.js")
              ? "\nexport { runDashboardActivityPass, runEarnActivityPass, runClaimReadyPass };\n"
              : "") +
            (options.mobilePatchProbe &&
            file === path.join(root, "js/service.js")
              ? `\nexport { search };\nexport function prepareMobilePatchProbe() {
                  config.control.clear = 1;
                  config.runtime.running = 1;
                  config.runtime.mobile = 1;
                  config.runtime.rsaTab = 1;
                  needPatch = true;
                }\n`
              : ""),
          {
            identifier: file,
            context,
          },
        ),
      );
    }
    return modules.get(file);
  };
  const defaults = load("/js/config-defaults.js");
  await defaults.link(load);
  await defaults.evaluate();
  if (options.config !== null) {
    const config = defaults.namespace.createDefaultConfig();
    config.control.act = 0;
    config.control.clear = 0;
    config.search = { ...config.search, desk: 1, mob: 0 };
    config.schedule = {
      ...config.schedule,
      desk: 1,
      mob: 0,
      mode: options.mode || "m1",
    };
    Object.assign(config.runtime, options.runtime || {});
    store.config = clone(config);
  }
  const worker = load("/js/service.js");
  await worker.link(load);
  await worker.evaluate();
  await settle();
  return {
    store,
    chrome,
    tabsCreated,
    tabsRemoved,
    alarms,
    pendingRewardsReads,
    debuggerCommands,
    browsingDataCalls,
    diagnosticDownloads,
    namespace: worker.namespace,
    getFetchCalls: () => fetchCalls,
    async send(message) {
      const response = new Promise((resolve) => {
        for (const listener of chrome.runtime.onMessage.listeners)
          listener(message, {}, resolve);
      });
      const result = await response;
      await settle();
      return result;
    },
    async tick() {
      const queued = [...timers];
      for (const [id, fn] of queued) {
        timers.delete(id);
        fn();
      }
      await settle();
    },
  };
}

async function run(scenario) {
  const worker = await bootWorker(scenario);
  const results = [];
  let passResult;
  if (scenario.mobilePatchProbe) {
    worker.namespace.prepareMobilePatchProbe();
    let finished = false;
    const searchResult = worker.namespace.search(1, 7, 7).then((result) => {
      finished = true;
      return result;
    });
    for (let step = 0; step < 100 && !finished; step++) await worker.tick();
    if (!finished) throw new Error("Mobile patch probe did not finish");
    await searchResult;
  }
  if (scenario.activityPassProbe) {
    const engine = worker.namespace;
    const args = [1, { attempts: {} }, new Set(), new Map(), 1, () => true];
    passResult =
      scenario.activityPassProbe === "dashboard"
        ? await engine.runDashboardActivityPass(...args)
        : scenario.activityPassProbe === "earn"
          ? await engine.runEarnActivityPass(...args)
          : await engine.runClaimReadyPass(1, 1, () => true);
  }
  for (const message of scenario.messages || []) {
    results.push(await worker.send(message));
    if (scenario.pauseRewardsSession && message.action === "activity") {
      // Reach the actual activity engine and pause its account check before
      // testing Stop followed by a new search session.
      await worker.chrome.tabs.onUpdated.emit(1, { status: "complete" });
      await settle();
      await worker.chrome.tabs.onUpdated.emit(1, { status: "complete" });
      await settle();
      await worker.tick();
      if (!worker.pendingRewardsReads.length)
        throw new Error("Activity did not reach Rewards session check");
    }
  }
  if (scenario.pauseRewardsSession) {
    for (const resolve of worker.pendingRewardsReads)
      resolve({
        ok: true,
        json: async () => ({ status: { userStatus: { availablePoints: 10 } } }),
      });
    await settle();
  }
  if (scenario.finishEmptyActivity) {
    for (let step = 0; step < 40 && worker.store.config.runtime.running; step++)
      await worker.tick();
    if (worker.store.config.runtime.running)
      throw new Error("Empty activity run did not finish");
  }
  if (scenario.completeTabAfterMessages) {
    await worker.chrome.tabs.onUpdated.emit(scenario.completeTabAfterMessages, {
      status: "complete",
    });
    await settle();
  }
  if (scenario.alarm) {
    // Alarm handlers await the entire run; observe its start without waiting
    // for the deliberately suspended tab loading in this harness.
    void worker.chrome.alarms.onAlarm.emit({ name: scenario.alarm });
    await settle();
  }
  if (scenario.startup) {
    // Startup handlers contain a 15s warmup; trigger it deterministically.
    void worker.chrome.runtime.onStartup.emit();
    await settle();
    await worker.tick();
  }
  await settle();
  process.stdout.write(
    JSON.stringify({
      results,
      config: worker.store.config,
      tabsCreated: worker.tabsCreated,
      tabsRemoved: worker.tabsRemoved,
      alarms: Object.fromEntries(worker.alarms),
      debuggerCommands: worker.debuggerCommands,
      browsingDataCalls: worker.browsingDataCalls,
      diagnosticDownloads: worker.diagnosticDownloads,
      fetchCalls: worker.getFetchCalls(),
      passResult,
    }),
  );
}

if (require.main === module) {
  run(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
