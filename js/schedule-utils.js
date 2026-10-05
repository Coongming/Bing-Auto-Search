export const SCHEDULE_ALARM_MODES = {
  m3: { min: 300, range: 150 },
  m4: { min: 900, range: 150 },
};

export function getScheduleAlarmDelayMs(mode) {
  const spec = SCHEDULE_ALARM_MODES[mode];
  if (!spec) return null;
  return (Math.floor(Math.random() * spec.range) + spec.min) * 1000;
}

export function isScheduledModeActive(schedule) {
  return (
    !["m1", "m2"].includes(schedule?.mode) &&
    (Number(schedule?.desk) !== 0 || Number(schedule?.mob) !== 0)
  );
}

export async function armScheduleAlarmForMode(
  mode,
  createAlarm = (name, opts) => chrome.alarms.create(name, opts),
) {
  const delayMs = getScheduleAlarmDelayMs(mode);
  if (!delayMs) return false;
  await createAlarm("schedule", { when: Date.now() + delayMs });
  // Return the actual armed delay so callers can log the real value instead
  // of drawing a fresh (different) random number.
  return delayMs;
}
