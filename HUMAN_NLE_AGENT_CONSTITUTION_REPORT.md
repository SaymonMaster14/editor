# Human NLE + Agent Constitution — Engineering Report

## Starting state

- Branch: `diffusion-on-steroids` (continues; NLE work builds on Steroids, no reset)
- Starting SHA (this goal): `2627e42` (flow phase, post-OOM recovery)
- Steroids final SHA: `2627e42` — committed, tested, pushed to `fork/diffusion-on-steroids`
- Upstream SHA (`origin/main`): `57c3983` — ancestor of HEAD (no divergence)
- Remote `fork`: `https://github.com/SaymonMaster14/editor` (branch pushed, tracking set)
- OOM recovery: session `01a0c5c1` crashed (`crash_inferred`) right after phase T;
  interrupted work was the optical-flow phase (smoke done, worker not started).
  Recovered as commit `2627e42` (`media_flow`, E2E 16/16). Tree was otherwise clean.

## Baseline capability map (audited, not assumed)

### Already exists — reuse, don't duplicate

| Area | Where | Notes |
|---|---|---|
| Canonical edit funnel | `apps/web/src/engine/editor.ts` (`DocumentEditor`) | All mutations go through it |
| Undo/redo + transactions | `apps/web/src/engine/history.ts` (`EditHistory`) | Invertible pairs, gestures, coalescing, 100 steps |
| Source sync | `apps/web/src/projects/edits.ts` (`EditWriter`) | Debounced file writes from the same funnel |
| Central shortcuts | `apps/web/src/engine/input/shortcuts.ts` | One table; J/K/L shuttle, space, undo/redo, split, nudge, seek |
| Timeline UI | `apps/web/src/engine/timeline/` | Immediate-mode canvas: drag, snapping, marquee, ruler, workarea, playhead |
| Split | `apps/web/src/engine/split.tsx` | `splitAtPlayhead`, bound to mod+B |
| Timing/keyframes/groups | `timing.ts`, `keyframes.tsx`, `group.tsx`, `overlap.ts`, `placement.ts` | Candidates for NLE ops foundation |
| Harness registry | `packages/agent-chat/src/host/` | codex/claude/opencode/muse + fake; MCP, resume, questions, approvals plumbing |
| DAPI/MCP + QA + cache | `packages/dapi`, `apps/web/src/dapi` | Tool catalog, qa_sweep, analysis cache, resource scheduler, model workers |

### Missing — the work of this goal

- NLE ops: ripple/roll/slip/slide, lift/extract — DONE (milestone below).
  Insert/overwrite, I/O range, source monitor — DONE (source milestone below).
  Markers — still missing.
- Premiere keymap gaps: frame step is on A/D, arrows nudge pixels; no edit-point
  navigation. I/O + insert/overwrite (`,`/`.`) DONE (source milestone below);
  J/K/L shuttle exists.
- Permission model: all harnesses default to maximum access
  (codex `danger-full-access` + approval `never`; claude `bypass`; muse `allowAll`;
  "ask before acting outside this folder" is prompt text only).
  `HarnessCapabilities` has no filesystem/sandbox fields.
- Production integrity / native-first enforcement: no editability validator;
  `check` validates project state, not native-vs-flattened representation.
- Architecture checks: no `check:architecture`, no exceptions file.

## Plan (milestones)

1. Baseline / capability map (this report skeleton) — commit.
2. Canonical semantic edit commands on `DocumentEditor` (timing domain first).
3. Transactions + undo hardening for compound NLE ops; stress tests.
4. Ripple/roll/slip/slide/lift/extract + split/trim improvements.
5. Source range (I/O) + source monitor + insert/overwrite.
6. Premiere keymap pass on the central shortcut table.
7. Keyframe/canvas/audio human-correction gaps.
8. Permission model: per-root read/write policy + harness mappings (honest matrix).
9. Native-first policy + escalation receipts + production-integrity check.
10. Architecture constitution + executable checks.
11. Fire tests (human NLE, human→agent, cheating, monolith, filesystem).
12. Packaging + regression + final report/matrices.

## Milestone: canonical NLE ops + timeline_edit (plan §2–§4)

Commits `f100da6` (ops + tool + CLI) and `6e6f4c9` (id-preserving undo),
pushed to `fork/diffusion-on-steroids`.

- `apps/web/src/engine/nle.ts` (new): canonical lift/extract/rippleTrimIn/
  rippleTrimOut/roll/slip/slide over `DocumentEditor` + one history gesture
  each; roll/slide clamp to source handles and report the applied point.
- `timeline_edit` DAPI tool + handler + `dapi timeline` CLI with
  spans/removed/shifted readback; removed clips named before removal.
- Undo of a remove restores the original node id end to end
  (`CapturedNode.id` → history reinsert → `SourceWriter` honors the
  requested id when free, temp+rename when the same write cuts the
  previous holder; `spell()` strips id so copies never claim it).
- Writer unit tests (`apps/desktop/src/edit.test.ts`): free/taken/
  same-write-remove id cases, 4/4 with the pre-existing test.
- E2E `tmp/nle-e2e/proof.mjs`: 27/27 on an isolated live instance
  (fresh profile, `DIFFUSION_DEV_NO_AUTH=1`, own MCP port) — roll/trim/
  ripple/extract/undo/redo/slip/slide/multi-extract/lift, source sync,
  error cases, reopen persistence. Fixture media is a looped 360-frame
  cut (`street-long.mp4`): the 90-frame original leaves full-length
  clips with no source handles, which made the first roll assertions
  unachievable in Computed terms.

## Milestone: source range + monitor + insert/overwrite (plan §5–§6)

Commits `f34d46a` (canonical engine), `f490361` (`source_edit` tool +
handler + CLI), `9421ac8` (monitor panel + shortcuts), pushed to
`fork/diffusion-on-steroids`.

- `SourceMonitor` world trait (`apps/web/src/engine/traits.ts`, registered
  in `create-engine.ts`): loaded asset id, preview position, in/out range
  in source seconds. Editor state, never authored — the one range the
  monitor UI, the I/O shortcuts, and `source_edit` all read and write.
- `apps/web/src/engine/source-edit.ts` (new): `loadSourceMonitor`,
  `scrubSourceMonitor`, `markIn`, `markOut`, `insertEdit`, `overwriteEdit`
  over `insertAsset` + `timing.ts` + `nle.ts` + `overlap.ts`, one history
  gesture each. Insert cuts the straddled clip (never a container —
  containers shift whole or stand) and ripples later siblings; overwrite
  settles covered spans under sequences via the extracted
  `resolveSpanOverlap` (the same settle a drop gets) and leaves layers
  alone elsewhere. Placed clips get fresh readable authored ids
  (`freshClipId`, honored by the writer), and `insertAsset` accepts an
  explicit `id` for callers that address the clip next.
- `source_edit` DAPI tool + renderer handler + `dapi source` CLI
  (load/markIn/markOut/scrub/insert/overwrite/range). The handler waits
  out the ~120ms file-sync restamp so the reported `placed` id is settled
  and immediately targetable in the next call.
- `SourceMonitorPanel` (new, in the asset inspector): position/run
  readout, Mark In/Out, the marked range, Insert/Overwrite landings with
  shortcut-hint tooltips. Selecting an asset loads it ranged end to end
  (keyed on the id string, so library refreshes don't wipe marks); the
  preview reports its position back (scrub/seek/pause exact, playback at
  timeupdate rate); a mismatch line + Load selected covers an agent
  holding another asset. Central shortcuts gain `I` (mark in), `O`
  (mark out), `,` (insert), `.` (overwrite) — all free, text fields
  excluded centrally.
- E2E `tmp/source-e2e/proof.mjs`: 22/22 on the live stack — range/load/
  markIn/markOut/scrub, insert ripple + file sync of `sourceIn`/`sourceOut`
  with readable `id="street"`, immediate retarget of the placed clip,
  undo/redo as one step, overwrite settle, error cases, reopen
  persistence. NLE proof re-run 27/27 (overlap extraction + `insertAsset`
  change regression-clean).
- Panel verified live: asset selection mounts it and its load effect fires
  (CLI `source range` reads the monitor at 0–12s), renderer logs clean.
  Verified via a temporary `selectAsset` probe op, removed with zero
  residue before commit (no matches for it in the tree).

## Fire tests

NLE E2E (agent path over DAPI/CLI): 27/27 green, see milestone above.
Source E2E (agent path): 22/22 green, see source milestone above.
Monitor panel live-verified (mount + select→load + clean logs); physical
key/click presses of I/O/`,`/`.` and the panel buttons are human-verified
(see Limitations — sandbox UIPI blocks synthetic OS input here).
Human→agent, cheating, monolith, and filesystem fire tests still pending
(plan §11). Evidence artifacts stay under `tmp/`.

## Performance

Pending measurement on a realistic project.

## Regression

Steroids gate at starting SHA: flow-worker 10/10, present 14/14, dapi 78/78,
cli 15/15, typecheck clean (dapi/desktop/web/cli), lint 0 errors
(3 pre-existing warnings in `apps/web/src/projects/edits.ts`),
flow E2E 16/16 on the live stack, RAFT/DIS ground-truth errors 0.16/0.10px.

Source-milestone gate at `9421ac8`: `npm run check` clean (all workspaces);
unit suites green (dapi 78/78, cli 15/15, desktop 207/207 — the desktop
runner still exits 1 on the pre-existing libuv `fs-event.c` watch
assertion, see Limitations); `eslint` web 0 errors; source E2E 22/22 and
NLE E2E 27/27 on the live stack.

## Limitations

- `apps/desktop` suite: `projects.watch.test.ts` crashes its vitest worker
  via a libuv `fs-event.c` assertion (also in isolation; its module graph
  is disjoint from the NLE/writer changes). Pre-existing/environmental;
  the rest of the suite is 207/207.
- Redo of an insert mints a fresh id (only remove→undo restores ids).
- Physical key/click verification of the new shortcuts and panel buttons
  was not possible from this sandbox: synthetic `mouse_event` input is
  silently dropped by UIPI (cursor moves, clicks don't land), there is no
  CDP port on the dev Electron, and no headless selection path exists.
  The panel was verified live via mount + reactive effect + clean logs
  instead; the shortcuts are data-table entries over E2E-proven ops.
  Human fire-test item (§54.19–25) remains for a real keyboard.
- Monitor insert/overwrite from the UI default to the active scene at the
  playhead (same destination as canvas/timeline drops); landing inside a
  sequence needs the DAPI `parent` today — there is no destination picker
  in the panel yet.
- I/O marks during full-motion playback read the last mirrored preview
  position (~4Hz timeupdate); scrub/pause/seek-then-mark is frame-exact.
- Dev gotcha (pre-existing): tool schemas are baked into the desktop main
  bundle at stack start, so DAPI schema changes need an app restart —
  Vite HMR only refreshes renderer handler logic.
- OOM timestamps: user recalled ~02:00; crash was ~04:52 (phase-T commit 04:49).
  No work was lost: tree was clean, only the unstarted flow worker remained.
- Steroids "documentation" is commit messages + in-code docs (repo convention);
  no separate Steroids report file exists.

## Final SHA

Pending — goal continues. Interim HEAD: `9421ac8`
(`fork/diffusion-on-steroids`), source slice complete through plan §5–§6.
