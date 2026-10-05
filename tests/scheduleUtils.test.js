"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.join(__dirname, "../js/schedule-utils.js"),
  "utf8",
);
const modifiedSource = `${source.replace(/export /g, "")}
module.exports = {
  SCHEDULE_ALARM_MODES,
  getScheduleAlarmDelayMs,
  isScheduledModeActive,
  armScheduleAlarmForMode,
};
`;

const sandbox = {
  module: { exports: {} },
  chrome: { alarms: { create: jest.fn() } },
};
vm.createContext(sandbox);
vm.runInContext(modifiedSource, sandbox);

const { getScheduleAlarmDelayMs, isScheduledModeActive, SCHEDULE_ALARM_MODES } =
  sandbox.module.exports;

describe("schedule-utils", () => {
  test("exposes m3 and m4 alarm modes", () => {
    expect(SCHEDULE_ALARM_MODES.m3).toEqual({ min: 300, range: 150 });
    expect(SCHEDULE_ALARM_MODES.m4).toEqual({ min: 900, range: 150 });
  });

  test("getScheduleAlarmDelayMs returns null for unsupported modes", () => {
    expect(getScheduleAlarmDelayMs("m1")).toBeNull();
  });

  test("getScheduleAlarmDelayMs stays within configured bounds", () => {
    const delayMs = getScheduleAlarmDelayMs("m3");
    expect(delayMs).toBeGreaterThanOrEqual(300000);
    expect(delayMs).toBeLessThanOrEqual(450000);
  });

  test("isScheduledModeActive ignores m1/m2 and zero plans", () => {
    expect(isScheduledModeActive({ mode: "m1", desk: 10, mob: 5 })).toBe(false);
    expect(isScheduledModeActive({ mode: "m3", desk: 0, mob: 0 })).toBe(false);
    expect(isScheduledModeActive({ mode: "m4", desk: 5, mob: 3 })).toBe(true);
  });
});
