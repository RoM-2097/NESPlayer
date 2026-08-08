# NESPLAYER — Restore 60 FPS in netplay (latency probe + adaptive tuning)

## Goal
Fix the netplay lockstep dropping to ~50 FPS. Root cause: the adaptive input-delay
tuner only grows the render delay when the miss rate exceeds 20%, but at 50 FPS
the miss rate is ~17% — so it never adapts and stays permanently stuck. Also, the
WebRTC migration removed the pre-match RTT calibration that the old WebSocket
version had.

## Tasks
- [x] Understand the game loop + netplay lockstep FPS pacing.
- [ ] `js/netplay.js`: add state vars for calibration (rttSamples, pingSends,
      pingSeq, calibrating, probeDeadline, probeDone).
- [ ] `js/netplay.js`: add `sendPing`, `computeAdaptiveDelay`, `startLatencyProbe`,
      `finishLatencyProbe`, `scheduleProbeTimeout`.
- [ ] `js/netplay.js`: route probe messages ('ping','pong','probe-done') through
      `handleReliableMessage` over the reliable data channel.
- [ ] `js/netplay.js`: host initiates probe after ready handshake; guest waits for
      `probe-done` before becoming ready (no longer self-bootstraps into playing).
- [ ] `js/netplay.js`: lower adaptive tuning threshold (missRate > 0.10, window 30)
      so the render delay grows promptly to cover real RTT/jitter.
- [ ] `js/netplay.js`: reset calibration vars in `resetState`.
- [ ] Verify: `node --check js/netplay.js`.
- [ ] Verify: run soak test (`server/_run_soak.ps1`) — sustained 120+ frames, no stall.

## Bug fix (Reset in netplay froze on a black screen)
- [x] `js/netplay.js`: add `GG.reset()` — a netplay-aware reset that resets the
      local core, re-syncs the lockstep counters to frame 0 via `resetLockstep()`,
      and sends a `'reset'` message so the peer does the same.
- [x] `js/netplay.js`: handle the incoming `'reset'` reliable message in
      `handleReliableMessage` (peer resets its core + lockstep state too).
- [x] `js/netplay.js`: add `resetLockstep()` so the render/live frame counters,
      input seed buffers, and adaptive-delay state are all reset together without
      tearing the session down.
- [x] `js/app.js`: `resetGame()` now calls `GG.reset()` when a live netplay
      session is active (instead of a plain `nes.reset()`). A bare `nes.reset()`
      left the netplay frame counters at their pre-reset (high) values, so
      `GG.step()` waited for an already-consumed peer input and froze on a black
      screen.
