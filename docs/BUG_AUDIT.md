# Gorilla FFA Bug Audit

## Scope

Audit performed on the Phase 3 prototype's input, ragdoll locomotion, grab constraints, climbing, respawn flow, and HUD update paths.

## Verified And Fixed

| Severity | Finding | Fix |
| --- | --- | --- |
| Critical | A void-fall could clear grab flags without removing the Cannon constraint, leaving a dummy welded or stuck in its no-wander state. | `Game.releaseGrab()` is the single cleanup path. `syncGrabState()` runs before input and immediately after respawn detection. |
| Critical | Climb top-out used the wall's outward normal, pushing the gorilla away from the platform instead of onto it. | Mantles now move inward, set a safe surface height, and receive a controlled inward exit velocity. |
| High | Padded side wall grabs could top out beyond a platform corner. | Mantle exits clamp the along-wall coordinate inside the top surface. |
| High | The held target was closer than two torso radii, making its grab constraint fight sphere collision. | `GRAB.holdDistance` was raised from `1.25` to `1.6`. |
| High | A camera-relative climb exit heuristic released a climb when W was pressed in common camera angles. | The heuristic was removed; climb exits are deliberate (E/Space) or boundary-driven. |
| Medium | Attach and stay bounds differed without clamping, producing instant detach near padded grab limits. | Attach Y is clamped to the valid climb face and continuous bounds are intentionally looser. |
| Medium | Releasing a wall could immediately reattach. | Added a short `CLIMB.reattachCooldown`. |
| Medium | Throw charge and climbing prompts refreshed only on a slow stats interval. | HUD refreshes every frame while charging or climbing. |

## Verification

- TypeScript/Vite production build: passed with the provided build tool.
- Runtime manual physics testing remains browser-only and should cover: mantle at each platform corner, wall-jump/re-grab cooldown, void fall while holding, dummy void fall while held, full throw charge UI, and slam near a tier edge.