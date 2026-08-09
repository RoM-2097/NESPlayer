# NESPLAYER — Fix "Netplay stalled" freeze (lost-frame recovery)

## Goal
Fix the netplay lockstep freezing after a short while with a "Netplay stalled"
error. Root cause: a single dropped UDP input packet makes `GG.step()` HOLD
forever (no re-request mechanism), and `lastStep` isn't updated on a hold, so
after 3000ms `STALL_TIMEOUT` bails the session to single-player.

The recovery mechanism (req-input / input-relay) was in place, but two flaws
caused a hold-forever deadlock:

1. The `req-input` request was sent only ONCE per missing frame. If the peer was
   momentarily BEHIND (hadn't yet captured that live frame, so `localInputs[frame]`
   was empty), it could not answer; the request was never re-sent, so the frame
   was never delivered and BOTH sides held forever.
2. `lastStep` was refreshed on EVERY hold, so `STALL_TIMEOUT` never fired — a
   genuinely dead/stuck peer was never bailed, masking the freeze.

## Tasks
- [x] `js/netplay.js`: add a `lastReqrAt` timestamp + a `LOST_REQ_RETRY_MS`
      retry interval so a `req-input` that the peer couldn't answer (not-yet-
      captured frame) is re-sent periodically until the peer catches up.
- [x] `js/netplay.js`: in `GG.step()`, only refresh `lastStep` when a request is
      FIRST sent for a frame (recovery in-flight). On a retry, do NOT refresh
      `lastStep`, so a genuinely dead/stuck peer still trips `STALL_TIMEOUT`.
- [x] `js/netplay.js`: remove the `lastReqr = -1` reset in the `input-relay`
      handler so a stale/old relay can't re-arm the throttle and mask a stall.
- [x] Verify: `node --check js/netplay.js`.
