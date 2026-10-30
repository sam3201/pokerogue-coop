<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

# Low-resource browser mode (Pi / ARM Linux)

The production game keeps its standard graphics on ordinary desktop and
mobile browsers. On Linux/ARM Chromium it automatically uses a reduced
presentation profile. You can override either device type:

- `?graphics=low` — enable low-resource presentation.
- `?graphics=full` — restore normal Phaser rendering.

This mode leaves gameplay, input handling, game coordinates, and co-op
lockstep calculations unchanged. It uses a real **320 × 180 WebGL drawing
buffer** while preserving Phaser's 1920 × 1080 logical coordinate space,
and redraws on key/pointer/touch events, phase/UI changes, or every 120
simulation frames. The last presented frame is retained by the browser
between redraws. Phaser time-step smoothing is disabled for the slow-GPU
profile so summon animations advance according to real elapsed time.

Chromium uses its existing WebGL hardware driver; no new browser or native
C/WASM runtime is needed. No persistent frame-capture logs or browser
accounts are created by this profile.

## Limitations

Some continuous animations may look choppy; large offscreen render targets
are not resized, so overall GPU memory reduction is not guaranteed. For
visual-heavy play, screenshots, or debugging, use `?graphics=full`.
This profile was validated with two separate first-wave co-op starter
pairs on Raspberry Pi 5 using isolated browsers. Longer campaigns and
other GPUs have not received equivalent acceptance coverage.

The game's source must stay accessible to players, consistent with its
AGPL-3.0 license. This repository is a derivative of PokéRogue and
PokéRogue Co-op; see the repository's credits and licensing files.
