# Olela Pathfinder Fork

This directory is the canonical source for the pathfinder used by cloud-store.
Do not patch `node_modules/mineflayer-pathfinder` directly.

Base source: the repository snapshot previously stored as
`node-bot/pathfinder-master.tar.gz` (SHA-256
`bbcd120a0f5922c69e6b23c8054e87bff42fd2d99bf47e765a8c6aa2a3ac07ee`).

Olela patch version: `2026.08.06.18-r5-lossless`.

Maintained extensions:

- complete-path-first behavior when partial execution is disabled;
- best-so-far `partialSegment` execution with replanning from the real position;
- strict `goto()` completion semantics;
- path and movement diagnostics through `path_debug` and `getDebugState()`;
- path-aware chunk-load invalidation;
- explicit pathfinder control pause/resume for exclusive rescue movement;
- identity-bound pause tokens and deterministic goal replacement while paused;
- immediate cancellation of movement, digging, placement, and stale async callbacks.
- detached execution nodes with typed surface, water, and climbable arrival rules;
- per-node vertical-delta recomputation after an execution-path shift;
- settled fractional-snow arrival tolerance for the server's resting Y offset;
- grounded walking preference on non-rising snow edges, with an explicit
  no-delayed-jump reachability check before suppressing a sprint jump;
- backoff ownership keyed to the full path node lifecycle, so reaching the
  target Y alone cannot cancel preparation before XZ arrival.
- indexed open-heap decrease-key bookkeeping that preserves the legacy
  comparison and tie order while removing the linear `heap.indexOf` scan.
- self-dig awareness in the `blockUpdate` invalidation, so tunnelling keeps the
  planned path and never cancels its own in-flight dig;
- guarded navigation treats an active dig as expected stationary work instead
  of pausing it after four seconds; a block is dug continuously until its own
  dig promise completes or fails;
- 1x1 towers equip scaffolding before takeoff, place only while rising with
  collision clearance, and ignore their own confirmed placement update so the
  remaining tower path is preserved;
- guarded navigation also treats active scaffold placement as expected
  stationary work for the server confirmation window (then restores stall
  recovery), and a timed-out placement is accepted when the destination is
  already a physical support block on the live server;
- an unloaded dig target replans instead of dereferencing a null block;
- `monitorMovement` failures degrade to a `monitor_error` replan instead of
  escaping through `physicsTick` and killing the process;
- execution nodes stay block-centered across `toBreak`/`toPlace` nodes. Upstream
  stops centering at the first such node, which is harmless for its loose
  controller but not for this fork's physics-simulated one: aiming at a block
  corner makes every candidate move collide, so `selectMoveControls` returns
  `blocked_no_motion` and the bot stands still. Since every `canDig` path
  contains a `toBreak` node, tunnelling navigation failed before it dug
  anything;
- a persistent `blocked_no_motion` edge forces a replan after a short grace
  period instead of waiting out the generic no-progress budget, because the
  control simulator has already ruled the edge out and only fresh block data
  can change that.

The root project verifies these capabilities with `npm test` and `npm run check`.
See `docs/pathfinder.md` for the warehouse integration and its limitations.
