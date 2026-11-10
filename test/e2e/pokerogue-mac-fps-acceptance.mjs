/**
 * Pure acceptance logic for macOS foreground, live-wave animation samples.
 * Does not access the browser, network, disk, user profiles, or game saves.
 */
export function assessMacGameplayFrames(sample, opts = {}) {
  const minFps = opts.minFps ?? 30;
  const maxP95Ms = opts.maxP95Ms ?? 50;
  if (!Number.isFinite(minFps) || minFps <= 0
    || !Number.isFinite(maxP95Ms) || maxP95Ms <= 0) {
    throw new RangeError("invalid Mac frame-performance thresholds");
  }
  const timings = sample?.frameIntervalsMs;
  if (!Array.isArray(timings)
    || timings.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)
    || !(sample.elapsedMs > 0 && Number.isFinite(sample.elapsedMs))
    || !Number.isInteger(sample.frameCount) || sample.frameCount < 1
    || timings.length !== sample.frameCount - 1) {
    throw new TypeError("invalid browser frame-timing evidence");
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const percentile = q => sorted.length
    ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
    : null;
  const round = n => n == null ? null : Math.round(n * 100) / 100;
  const rafFps = round(1000 * sample.frameCount / sample.elapsedMs);
  const p95Ms = round(percentile(.95));
  // A wave number alone is insufficient: unknown, title and reward phases
  // do not establish gameplay activity. This gates false-positive samples.
  const phase = sample.phaseAtStart;
  const inWave = Number.isInteger(sample.waveAtStart) && sample.waveAtStart >= 1
    && typeof phase === "string" && phase.endsWith("Phase")
    && !["TitlePhase", "SelectStarterPhase", "SelectModifierPhase",
      "GameOverPhase", "PostGameOverPhase"].includes(phase);
  const endPhase = sample.phaseAtEnd;
  const remainedInGameWave = Number.isInteger(sample.waveAtEnd)
    && sample.waveAtEnd === sample.waveAtStart
    && typeof endPhase === "string" && endPhase.endsWith("Phase")
    && !["TitlePhase", "SelectStarterPhase", "SelectModifierPhase",
      "GameOverPhase", "PostGameOverPhase"].includes(endPhase);
  const valid = sample.visibility === "visible"
    && sample.focused === true
    && inWave && remainedInGameWave
    && sample.renderBackend === 2
    && sample.canvasCount >= 1
    && Number.isInteger(sample.submittedInputs) && sample.submittedInputs > 0
    && sample.elapsedMs >= 6000
    && sample.frameCount >= 10 && sorted.length >= 9;
  return {
    schema: "sam.pokerogue.mac_visible_coop_frame_acceptance.v1",
    validGameplaySample: valid,
    meetsFrameTarget: valid && rafFps >= minFps && p95Ms !== null && p95Ms <= maxP95Ms,
    measuredFps: rafFps,
    medianIntervalMs: round(percentile(.5)),
    p95IntervalMs: p95Ms,
    maxIntervalMs: round(percentile(1)),
    intervalsOver50Ms: sorted.filter(n => n > 50).length,
    intervalCount: sorted.length,
    frameCount: sample.frameCount,
    seconds: round(sample.elapsedMs / 1000),
    phaserReportedFps: sample.phaserReportedFps ?? null,
    phaseAtStart: sample.phaseAtStart ?? null,
    waveAtStart: sample.waveAtStart ?? null,
    phaseAtEnd: sample.phaseAtEnd ?? null,
    waveAtEnd: sample.waveAtEnd ?? null,
    submittedInputs: sample.submittedInputs ?? 0,
    visibleAndFocused: sample.visibility === "visible" && sample.focused === true,
    renderer: sample.rendererString ?? null,
    thresholds: { minFps, maxP95Ms },
    macOnly: true,
    macHardwareAccelerationVerified: false,
    gamePolicyTrainingPerformed: false,
  };
}
