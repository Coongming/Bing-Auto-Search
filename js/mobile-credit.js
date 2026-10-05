// URL navigation confirms a search was submitted, not that Rewards credited it.
export function createMobileCreditGuard({
  readSnapshot,
  delay,
  report,
  isActive,
}) {
  let baseline = null;
  let lastProgress = null;
  let lastChecked = 0;
  let complete = false;

  function valid(snapshot) {
    return (
      Number.isFinite(snapshot?.mobProgress) &&
      Number.isFinite(snapshot?.mobMax) &&
      snapshot.mobMax > 0
    );
  }
  return {
    async start() {
      const snapshot = await readSnapshot();
      if (!valid(snapshot)) {
        await report(
          "Cannot read the mobile Rewards counter. Check Microsoft login and mobile eligibility.",
          "warning",
        );
        return false;
      }
      baseline = lastProgress = snapshot.mobProgress;
      complete = snapshot.mobProgress >= snapshot.mobMax;
      await report(
        `Mobile counter before searches: ${baseline}/${snapshot.mobMax}.`,
        "update",
      );
      return true;
    },
    isComplete: () => complete,
    async check(submitted, final = false) {
      if (!final && submitted - lastChecked < 3)
        return { ok: true, complete: false };
      let snapshot = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!isActive()) return { ok: false, complete: false };
        if (attempt > 0) await delay(3500);
        if (!isActive()) return { ok: false, complete: false };
        snapshot = await readSnapshot();
        if (
          valid(snapshot) &&
          (snapshot.mobProgress > lastProgress ||
            snapshot.mobProgress >= snapshot.mobMax)
        )
          break;
      }
      lastChecked = submitted;
      if (!valid(snapshot)) {
        await report(
          "Stopped mobile: Rewards counter unavailable; submitted searches are not confirmed points.",
          "warning",
        );
        return { ok: false, complete: false };
      }
      if (
        snapshot.mobProgress <= lastProgress &&
        snapshot.mobProgress < snapshot.mobMax
      ) {
        await report(
          `Stopped mobile: no new points after ${submitted} submitted searches. Microsoft has not credited this batch.`,
          "warning",
        );
        return { ok: false, complete: false };
      }
      lastProgress = snapshot.mobProgress;
      complete = lastProgress >= snapshot.mobMax;
      await report(
        `Mobile Rewards confirmed: +${lastProgress - baseline} points (${lastProgress}/${snapshot.mobMax}).`,
        "success",
      );
      return { ok: true, complete };
    },
  };
}
