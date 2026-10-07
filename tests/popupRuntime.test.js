"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { loadEsmModule } = require("./esm-loader.js");
const { createDefaultConfig } = loadEsmModule("../js/config-defaults.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function openPopup({ config = createDefaultConfig(), fetch } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://extension.test/popup.html",
    runScripts: "outside-only",
  });
  const { window } = dom;
  const listeners = [];
  const store = config ? { config: clone(config) } : {};
  const emit = () => {
    for (const listener of listeners) {
      listener({ config: { newValue: clone(store.config) } }, "local");
    }
  };
  const local = {
    get: jest.fn((key, callback) => {
      const result =
        key == null ? clone(store) : { [key]: store[key] && clone(store[key]) };
      callback?.(result);
      return Promise.resolve(result);
    }),
    set: jest.fn((data, callback) => {
      Object.assign(store, clone(data));
      if (data.config) emit();
      callback?.();
      return Promise.resolve();
    }),
    remove: jest.fn((key) => {
      delete store[key];
      return Promise.resolve();
    }),
  };
  const chrome = {
    storage: {
      local,
      sync: { get: jest.fn().mockResolvedValue({}) },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    runtime: {
      getManifest: () => ({ version: "6.0" }),
      sendMessage: jest.fn().mockResolvedValue({ success: true }),
    },
    alarms: {
      clear: jest.fn().mockResolvedValue(true),
      create: jest.fn().mockResolvedValue(),
    },
    tabs: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const navigator = {
    locks: { request: async (_name, _options, callback) => callback() },
  };
  window.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  Object.assign(window, {
    chrome,
    fetch:
      fetch || jest.fn().mockResolvedValue({ json: async () => ({ show: 0 }) }),
    ...loadEsmModule("../js/utils.js", {
      chrome,
      navigator,
      console: window.console,
    }),
    ...loadEsmModule("../js/config-defaults.js"),
    ...loadEsmModule("../js/devices.js"),
    ...loadEsmModule("../js/messages.js"),
    ...loadEsmModule("../js/crash-logger.js", { chrome }),
  });
  window.eval(fs.readFileSync(path.join(__dirname, "../js/jquery.js"), "utf8"));
  const source = fs
    .readFileSync(path.join(__dirname, "../js/popup.js"), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "");
  window.eval(
    `${source}\nglobalThis.popupTest = { updateUI, sendMessageWithTimeout: typeof sendMessageWithTimeout === 'function' ? sendMessageWithTimeout : null };`,
  );
  await settle();
  return {
    window,
    chrome,
    store,
    emit,
    close: () => window.close(),
    click: (selector) => window.$(selector).trigger("click"),
  };
}

describe("popup Start/Schedule on a fresh Chrome profile", () => {
  let popup;
  afterEach(() => popup?.close());

  test("manual activities own a usable Stop button", async () => {
    const config = createDefaultConfig();
    Object.assign(config.runtime, {
      running: 1,
      mode: "activity",
      act: 1,
      currentSession: { id: "act-run", type: "activity" },
    });
    popup = await openPopup({ config });
    expect(popup.window.$("#activity").text()).toBe("Stop");
    expect(popup.window.$("#activity").prop("disabled")).toBe(false);
    expect(popup.window.$("#searchTrigger").prop("disabled")).toBe(true);
    popup.click("#activity");
    await settle();
    expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: "stop",
    });
  });

  test.each([
    ["#searchTrigger", "start"],
    ["#scheduleTrigger", "schedule"],
  ])(
    "%s works after the worker removes legacy consent and pro fields",
    async (selector, action) => {
      popup = await openPopup();
      popup.store.config = createDefaultConfig();
      await popup.window.popupTest.updateUI();
      popup.click(selector);
      await settle();
      expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action }),
      );
    },
  );

  test("registers buttons without waiting for the advertisement server", async () => {
    popup = await openPopup({ fetch: jest.fn(() => new Promise(() => {})) });
    popup.click("#searchTrigger");
    await settle();
    expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "start" }),
    );
  });

  test("initializes missing storage and opens the Search section", async () => {
    popup = await openPopup({ config: null });
    popup.click("#searchTrigger");
    await settle();
    expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "start" }),
    );
    expect(popup.window.$("#search").prop("hidden")).toBe(false);
    expect(popup.window.$("#search").css("display")).not.toBe("none");
  });

  test.each([
    ["search", "start"],
    ["schedule", "schedule"],
  ])(
    "sends the current %s form even without a change event",
    async (mode, action) => {
      popup = await openPopup();
      popup.window.$(`#${mode}Desk`).val(2);
      popup.window.$(`#${mode}Mob`).val(0);
      popup.click(`#${mode}Trigger`);
      await settle();
      expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          searches: expect.objectContaining({ desk: 2, mob: 0 }),
        }),
      );
    },
  );

  test("selecting a schedule frequency preserves counts and does not arm alarms", async () => {
    popup = await openPopup();
    popup.click("#scheduleMode .m3");
    await settle();
    expect(popup.store.config.schedule).toMatchObject({
      mode: "m3",
      desk: 31,
      mob: 21,
    });
    expect(popup.chrome.alarms.create).not.toHaveBeenCalled();
    expect(popup.chrome.alarms.clear).not.toHaveBeenCalled();
  });

  test("setting changes preserve a worker session newer than the popup snapshot", async () => {
    popup = await openPopup();
    Object.assign(popup.store.config.runtime, {
      running: 1,
      done: 7,
      currentSession: { id: "worker-session", type: "search" },
    });
    popup.window.$("#log").prop("checked", true).trigger("change");
    await settle();
    expect(popup.store.config.runtime).toMatchObject({
      running: 1,
      done: 7,
      currentSession: { id: "worker-session" },
    });
  });

  test("shows the worker error and permits another click", async () => {
    popup = await openPopup();
    popup.chrome.runtime.sendMessage.mockRejectedValue(
      new Error("Receiving end does not exist"),
    );
    popup.click("#searchTrigger");
    await settle();
    expect(popup.window.$(".runStatus").first().text()).toContain(
      "Receiving end does not exist",
    );
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(popup.window.$("#searchTrigger").prop("disabled")).toBe(false);
  });

  test("bounds a lost service worker response", async () => {
    popup = await openPopup();
    popup.chrome.runtime.sendMessage.mockImplementation(
      () => new Promise(() => {}),
    );
    expect(popup.window.popupTest.sendMessageWithTimeout).not.toBeNull();
    await expect(
      popup.window.popupTest.sendMessageWithTimeout({ action: "start" }, 10),
    ).rejects.toThrow("No response from service worker");
  });

  test.each(["search", "schedule"])(
    "%s owns Stop while the other Start button is disabled",
    async (mode) => {
      const config = createDefaultConfig();
      Object.assign(config.runtime, {
        running: 1,
        mode,
        currentSession: { id: "run", type: mode },
      });
      popup = await openPopup({ config });
      const other = mode === "search" ? "schedule" : "search";
      expect(popup.window.$(`#${mode}Trigger`).text()).toBe("Stop");
      expect(popup.window.$(`#${other}Trigger`).prop("disabled")).toBe(true);
      popup.click(`#${mode}Trigger`);
      await settle();
      expect(popup.chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: "stop",
      });
    },
  );

  test("shows a worker failure that happens after Start was acknowledged", async () => {
    popup = await openPopup();
    popup.click("#searchTrigger");
    await settle();
    popup.store.config.runtime.lastRunMessage =
      "Run failed: Could not attach debugger.";
    await popup.window.popupTest.updateUI();
    expect(popup.window.$(".runStatus").first().text()).toContain(
      "Could not attach debugger",
    );
  });
});
