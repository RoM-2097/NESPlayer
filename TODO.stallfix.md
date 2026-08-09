# NESPLAYER — Fix "Netplay stalled" freeze (lost-frame recovery)

## Goal
Fix the netplay lockstep freezing after a short while with a "Netplay stalled"
error. Root cause: a single dropped UDP input packet makes `GG.step()` HOLD
forever (no re-request mechanism), and `lastStep` isn't updated on a hold, so
after 3000ms `STALL_TIMEOUT` bails the session to single-player.

## Tasks
- [ ] `js/netplay.js`: add the `req-input` handling in `handleReliableMessage` —
      on receiving a `req-input` for a frame, re-send the peer's buffered
      `localInputs[frame]` via `{type:'input-relay', frame, p1, p2}`.
- [ ] `js/netplay.js`: add the `input-relay` handling in
      `handleReliableMessage` — store the relayed input into `peerInputs[frame]`.
- [ ] `js/netplay.js`: in `GG.step()`, when `peerInputs[renderFrame]` is missing,
      send a throttled `{type:'req-input', frame: renderFrame}` over the
      reliable channel instead of silently holding forever.
- [ ] `js/netplay.js`: in `GG.step()`, refresh `lastStep` while a recovery is
      in-flight so a recoverable packet loss does not trip `STALL_TIMEOUT`.
- [ ] Verify: `node --check js/netplay.js`.
