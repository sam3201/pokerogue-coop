/**
 * Slow-renderer cosmetic fallback for a linked co-op run.
 *
 * Phaser.TimerEvent can invoke a repeating text-character callback at most
 * once per game update. At ~2 FPS, an ordinary 40-character line can occupy
 * twenty seconds although its requested 20ms delay is ~800ms. Skip the
 * typewriter animation only at critically low FPS, and only when the line has
 * no character-level sound, fade, expression or explicit delay directives.
 *
 * This decision never changes battle simulation, player inputs, rewards,
 * prompt ownership or co-op synchronization. In particular it does not
 * call the message callback itself: MessageUiHandler's existing zero-delay
 * path owns exactly-once prompt/callback delivery.
 */
export interface CoopTextPacing {
  linked: boolean;
  actualFps: number;
  delayMs: number | null | undefined;
  text: string;
  hasInlineEffects: boolean;
}

/** Deliberately conservative to avoid changing healthy-game presentation. */
export function shouldFlushSlowCoopText({
  linked, actualFps, delayMs, text, hasInlineEffects,
}: CoopTextPacing): boolean {
  return linked === true
    && typeof text === "string" && text.length >= 4
    && hasInlineEffects === false
    && (delayMs == null || delayMs === 20)
    && Number.isFinite(actualFps) && actualFps > 0 && actualFps < 8;
}
