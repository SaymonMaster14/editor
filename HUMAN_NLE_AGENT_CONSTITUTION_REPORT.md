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
  Markers — DONE (markers milestone below).
  Keyframe/canvas/audio human-correction gaps — DONE (correction milestone
  below).
- Premiere keymap gaps: frame step is on A/D, arrows nudge pixels; no edit-point
  navigation. I/O + insert/overwrite (`,`/`.`) DONE (source milestone below);
  J/K/L shuttle exists.
- Permission model: all harnesses default to maximum access
  (codex `danger-full-access` + approval `never`; claude `bypass`; muse `allowAll`;
  "ask before acting outside this folder" is prompt text only).
  `HarnessCapabilities` has no filesystem/sandbox fields. — DONE
  (permission milestone below; muse file tools proven ungated, see
  Limitations).
- Production integrity / native-first enforcement: no editability validator;
  `check` validates project state, not native-vs-flattened representation. — DONE
  (integrity milestone below; live-agent cheating observation still pending).
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

## Milestone: canonical scene markers (plan §2–§4, §8–§10)

Commit `4ee8ac1`, pushed to `fork/diffusion-on-steroids`.

- Marker inspector + timeline-menu items audited first: both were dead
  (local signals, never mounted / no `onSelect`). No marker model existed
  anywhere. The slice mirrors the `workarea` scene-prop precedent instead
  of inventing marker entities (no layout risk under sequential parents):
  `Markers` runtime trait + `DEFAULT_MARKER_COLOR`
  (`packages/runtime/src/traits/timing.ts`), `CompositionProps.markers`
  + `SceneMarkerSpec`/`MarkerColor` (`packages/jsx/src/types.ts`, re-
  exported), `case 'markers'` in the reconciler (dedupes to one per
  frame, earliest first, applies the default color so a reopen reads
  back what the add wrote).
- `apps/web/src/engine/markers.ts` (new): `list/add/remove/move/clear/
  seekMarker` through `editProperty` — one write, one undo step, file
  sync. Adding where one stands updates it; moves onto an occupied frame
  are refused (no clobbering); seeks move the playhead with no file
  write. Drag bursts coalesce like a trim's (no gesture bracketing, per
  `editWorkarea`); discrete singles stay single.
- `render/markers.ts` (new, in the timeline render order): color-diamond
  flags in the ruler's upper band — click seeks, drag moves (skips
  occupied frames), double-click removes. Regions register after the
  ruler's, so a flag wins the press over a scrub. Marker frames join
  `getSnapFrames`.
- Central shortcuts gain `M` (add at playhead), `⇧M` (next), `⌥M`
  (previous) — the plain binding excludes the modifiers explicitly, so a
  shifted M never also adds. Timeline menu wired: add/next/prev/clear
  markers (⌥M moved from clear-all to previous-marker; the dead Audio
  submenu's ⌥M label dropped), plus honest "Set work area in/out" clicks
  replacing the dead "Mark in/out (I/O)" items (global I/O still marks
  the source monitor — focus-sensitive routing needs a panel-focus model
  that doesn't exist yet, see Limitations). `setWorkareaIn/Out`
  (`timing.ts`) clamp at the opposite edge. `MarkerPanel` rewritten live
  (flags list + seek/remove rows, time/name/color editor for the flag at
  the playhead) and mounted for scene selections.
- `marker` DAPI tool + renderer handler + `dapi marker` CLI
  (add/remove/move/list/seek/clear; any time form; reports flags in
  frames + seconds). Schema unit tests (4) colocated.
- E2E `tmp/marker-e2e/proof.mjs`: 26/26 on the live stack — every op,
  file sync of `<scene markers>` (incl. attribute removal on clear),
  one-per-frame update + occupied-move refusal, time forms, one-step
  undo/redo (sleeps past the 600ms coalesce window), error cases,
  reopen persistence with names/colors intact.
- Flags verified live on canvas: window screenshots prove the diamond
  appears with the trait (green@frame-0 under the "0" tick), vanishes on
  `clear`, and a pink@0 renders pink at the ruler origin
  (`tmp/marker-e2e/ruler-*.png`). NLE proof re-run 27/27, source proof
  re-run 22/22 (renderer/snapping/shortcut/menu changes
  regression-clean).

## Milestone: keyframe/audio corrections + canvas text editing (plan §7)

Commit `c2d71af`, pushed to `fork/diffusion-on-steroids`.

- Audited first: keyframe drag-move (timeline diamonds), easing panel,
  gain knob + mute/solo + volume automation, canvas
  move/resize/rotate/marquee/snapping, anchor picker, and alignment all
  already existed and are reused untouched. The gaps were: no value
  editor for a selected keyframe, no canonical keyframe ops (drag wrote
  `time` directly, Delete left empty tracks), no fade/pan UI (runtime
  `Fade`/`Pan` traits + JSX props existed), no keyframe/audio DAPI
  tools, and no direct canvas text editing.
- `engine/keyframes.tsx`: canonical `moveKeyframe` (clip-local frames,
  clamp at 0, occupied-frame refusal like markers),
  `setKeyframeValue`, `deleteKeyframe` (track goes with its last
  keyframe). Timeline drag, `toggleKeyframe`, and the Delete key (which
  partitions keyframe vs rest) all funnel through them.
- `KeyframeSettings` inspector panel (new, mounted above the easing
  panel for keyframe selections): property label, clip-local frame
  field, value field (CSS hex on color tracks), delete; multi-select
  deletes as a block.
- `engine/audio.ts` (new): canonical `setGain`/`setFadeIn`/`setFadeOut`
  /`setPan`/`setMuted` (dB clamp, rounding, unset-at-default, volume/pan
  keyframe sync). The audio panel's writes refactored onto them, plus
  new Fade In/Out (seconds) and Pan (-1..1, slider, keyframe diamond)
  rows reusing the existing `Keyframe` diamond component.
- `keyframe` + `audio_edit` DAPI tools + renderer handlers + `dapi
  keyframe`/`dapi audio` CLI (add/remove/move/set/list; set/get with
  gain/fadeIn/fadeOut/pan/muted; finite-number validation, track state
  readback for verify-without-reread).
- Canvas text editing: double-clicking a text leaf (both the entity and
  mask paths, when there is nothing to drill into) mounts a `<textarea>`
  over the node's box — positioned per frame in `hud-system.ts` from
  `entityQuad` (bbox, top-edge rotation, node typeface scaled by
  on-screen size), writing live through canonical `editText` with the
  `TEXT_EDIT` tool held, Enter commits, Escape restores, dragstart and
  rename cross-dismiss. Mirrors the `name-input` overlay pattern; no new
  runtime support needed.
- E2E `tmp/correct-e2e/proof.mjs`: 32/32 on the live stack — every
  keyframe/audio op, `<keyframeTrack>` + audio-prop file sync (incl.
  track removal on last delete, prop unset at default), occupied-frame
  refusal, clamp semantics, one-step undo/redo, error cases, reopen
  persistence. Motion proven on pixels: a capture at 0s/1s shows the
  title at x=400 vs x=100 (`tmp/correct-e2e/0f-01s.png`); app window
  screenshot healthy after the HUD/interaction changes. NLE 27/27,
  source 22/22, marker 26/26 re-run green.
- Honest outs: crop has no runtime/JSX support (masks are the native
  crop-ish tool); crossfades need an overlap model beyond this slice's
  fades; guides/safe-zones overlay deferred. Physical dblclick/panel/
  Delete-key verification is human-verified (see Limitations).

## Milestone: agent filesystem permission model (plan §8)

Commit `c4f4726`, pushed to `fork/diffusion-on-steroids`.

- `packages/agent-chat/src/host/policy.ts` (new): one canonical policy.
  `buildPolicy(projectRoot, { mode, roots })` with `project` (default) /
  `full` (explicit opt-in) modes and per-root read/write flags;
  `canonicalizePath` (Windows casing, `.`/`..` traversal, drive letters,
  UNC, realpath junctions), `checkRead`/`checkWrite` verdicts with
  reasons, `decideToolAction` (path extraction per tool shape),
  `scanShellCommand`/`suspiciousShell`/`unwrapShellCommand`/
  `classifyShellCommand` (read/mutate/unknown) for the shell boundary.
- Mapped into each harness at its deepest enforcement point, never as
  prompt text alone: codex runs approval `untrusted` so the host
  auto-decides every file/shell action against the policy (in-project
  auto-accept, outside auto-decline, unverifiable asks the user) — the
  sandbox row is defense-in-depth only, because the live matrix proved
  the Windows workspace sandbox does not contain the file tools;
  claude maps onto SDK permission modes; opencode onto ACP read vs
  mutating kinds; muse defaults to `onRequest` (`allowAll` only under
  full access) with host `approval/decide` verdicts, per-turn
  triple-delivery dedupe, `listPending` refetch for choiceless
  arrivals, and stale-requirement retry. `HarnessCapabilities` gains
  honest `sandbox`/`readRoots`/`writeRoots`: codex F/T/T, claude
  F/T/T, opencode F/F/F, muse F/T/**F** (see Limitations).
- `access-menu.tsx` (new) + store/header wiring: access mode selector,
  per-root read/write editor, persisted per chat; full-machine access
  is never the silent default.
- Tests: `policy.test.ts` + `harness-policy.test.ts` (normalization,
  roots, shell classification, per-harness mapping) plus fixture
  coverage for the muse notification-only and choiceless-listPending
  paths (`fake-msp.cjs` modes, `muse.test.ts` 14/14). agent-chat
  132/132, `tsc` clean, repo-wide `npm run check` clean.
- Live 4-harness filesystem matrix (`C:/tmp/matrix.mjs`, throwaway:
  needs auth + spends model calls, kept out of the repo) over
  PROJECT / APPROVED_READ_ONLY / APPROVED_READ_WRITE / FORBIDDEN
  with file tools AND shell: codex proven approval-gated green
  earlier (zero questions, bare mode green); final re-run quota-
  blocked ("usage limit", resets 16:34). Muse full run completed,
  0 questions: project + readwrite writes land, read-only and shell
  reads work, forbidden SHELL write blocked ("approval aborted") —
  but read-only and forbidden FILE writes both land in every MSP
  approval mode (`onRequest`, `promptUnmatched`, `denyUnmatched`),
  proving MSP never gates file tools. Claude: probe ready, send
  failed "Credit balance is too low" (environmental, unchanged).
  OpenCode: probe ready, session open rejected "free tier can only
  be used from within OpenCode" (environmental gate; earlier run
  also showed premiere-pro MCP sprawl at 128 tools).

## Milestone: native-first production integrity (plan §9)

Commit `8ede877`, pushed to `fork/diffusion-on-steroids`.

- `packages/assets/src/escalation.ts` (new): `ExternalEscalation`
  receipts (`tool`, `reason`, `scope` element/scene/footage,
  `missingCapability?`, `createdAt`) stored on the asset record, so the
  manifest round-trips them with no migration and no second database.
  `record-escalation` refuses transient bytes ("import first") and blank
  fields; a second receipt replaces the standing one, loudly.
- Pure verdict core `packages/dapi/src/production-integrity.ts` (no
  world, no fs): 8 asset roles (escalated/generated/imported/linked are
  attributed; project-local/transient/remote/unknown are not), union
  video-coverage math, one video asset covering ≥ 80% of the played
  window dominates. `flattened-scene` errors only on the full
  conjunction (dominant + unattributed + zero editable structure);
  `flattened-program` errors when a one-scene program is one flattened
  render; lone linked files warn (`linked-solo`, declare as footage to
  silence). Dominance alone never flags; groups/sequences don't count
  as structure (a wrapper around one clip is not a composition).
- `production_integrity` DAPI tool (op-dispatched `check` /
  `record-escalation`, cataloged next to `check`/`qa_sweep` — same QA
  family, not a second system) + renderer handler reusing `check.ts`
  visibility semantics + `production-integrity` CLI command. Check
  output is the structural receipt: per-scene nodes/byKind,
  editableNodes, animatedProperties, masks, dominant asset + role +
  coverage, issues; scene-targeted or whole-program.
- Native-first execution hierarchy + completion gate
  (`check`/`capture`/`production_integrity` with zero errors) added to
  the shared `chatInstructions` preamble every harness appends.
- Tests: 16 core + 4 schema (dapi 102/102). E2E 24/24 ALL PASS on a
  fresh live stack (`tmp/integrity-e2e/proof.mjs`): synthetic cheat
  fails with both error codes at role project-local/coverage 1.0;
  declare-to-pass loop, assets.yml receipt persistence, and reopen
  roundtrips; structure exempts the dominant clip; seeded linked file
  warns, footage declaration silences; wrong-kind/missing-node/blank/
  ghost-asset error cases. Repo-wide `npm run check` clean, handler
  lint clean.

## Fire tests

NLE E2E (agent path over DAPI/CLI): 27/27 green, see milestone above.
Source E2E (agent path): 22/22 green, see source milestone above.
Marker E2E (agent path): 26/26 green, see markers milestone above.
Correction E2E (agent path): 32/32 green, see correction milestone
above; keyframed motion proven on captured pixels; app window
screenshot healthy.
Monitor panel live-verified (mount + select→load + clean logs); marker
flags live-verified on canvas (appear/vanish/position/color via
screenshots). Physical key/click presses of I/O/`,`/`.`, M/⇧M/⌥M, flag
drag/click, and the panel buttons are human-verified (see Limitations —
sandbox UIPI blocks synthetic OS input here). MarkerPanel mount is
typecheck + code-path verified (no headless selection path exists to
drive a scene selection from CLI).
Filesystem fire test (§58–§59): live 4-harness matrix above — codex
enforcement proven, muse shell-only enforcement proven with file
tools honestly marked unenforceable, claude/opencode environmentally
blocked (no credit / free-tier gate). Integrity fire test (§56–§57):
the validator is proven against synthetic cheats (E2E 24/24), but no
live agent has yet been observed against the tempting task — that
observation, plus human→agent and monolith fire tests, still pending
(plan §11). Evidence artifacts stay under `tmp/` (now gitignored:
kept on disk, never committed).

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

Markers-milestone gate at `4ee8ac1`: `npm run check` clean (all
workspaces); unit suites green (dapi 82/82 incl. 4 marker schema tests,
cli 15/15, desktop 207 passed / 0 failed — same pre-existing
`projects.watch.test.ts` worker crash, module graph disjoint from the
marker changes); `eslint` 0 errors (same 3 pre-existing warnings);
marker E2E 26/26, NLE E2E 27/27, source E2E 22/22 on the live stack.

Correction-milestone gate at `c2d71af`: `npm run check` clean (all
workspaces); unit suites green (same counts — no new unit tests this
slice, desktop still exits 1 on the same pre-existing libuv
`fs-event.c` watch assertion); `eslint` 0 errors (same 3 pre-existing
warnings); correction E2E 32/32, marker E2E 26/26, NLE E2E 27/27,
source E2E 22/22 on the live stack (dev stack restarted once to load
the new MCP tools — the desktop main bundle bakes the catalog at
boot, per the dev-gotcha limitation).

Permission-milestone gate at `c4f4726`: `npm run check` clean (all
workspaces); agent-chat 132/132 (policy, harness-policy, muse 14/14
incl. notification-only + choiceless-listPending paths, opencode,
registry) with `tsc --noEmit` clean; NLE/source/marker/correction
E2E proofs untouched by this slice (agent-chat-only changes plus the
access-menu UI) and not re-run.

Integrity-milestone gate at `8ede877`: `npm run check` clean (all
workspaces); dapi 102/102 (16 integrity core + 4 tool schema),
agent-chat 132/132, assets 91/91, cli 15/15; new-handler eslint
clean; integrity E2E 24/24 ALL PASS on a fresh live stack (prior
stack predated the tool, so it was stopped and relaunched — catalog
bakes at boot). Earlier E2E proofs untouched by this slice and not
re-run.

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
  The monitor panel was verified live via mount + reactive effect + clean
  logs; the marker flags via canvas screenshots; the shortcuts are
  data-table entries over E2E-proven ops. The MarkerPanel mount itself
  (scene selection → panel) is typecheck + code-path verified only.
  Same for this slice: the KeyframeSettings panel mount (keyframe
  selection → panel), the audio fade/pan rows (clip selection → rows),
  the Delete-key keyframe routing, and the canvas text-field mount
  (text-leaf double-click → overlay) are typecheck + code-path
  verified over E2E-proven canonical ops — the ops they call are the
  ops the proof drives — but no headless path exists to click/select/
  double-click them from CLI. Human fire-test items (§54.13–17) remain
  for a real keyboard.
- No panel-focus model exists, so global I/O marks the source monitor even
  when the timeline has the user's attention; timeline in/out is menu
  clicks ("Set work area in/out") until focus-sensitive routing exists.
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
- Muse (MSP) file tools are UNGATED in every approval mode: live
  probes in `onRequest`, `promptUnmatched`, and `denyUnmatched` all
  landed both the read-only-root and the forbidden file write, while
  the forbidden shell write was blocked. "Project only" for Muse
  therefore means shell-decided + prompt-guided, never file-enforced;
  capabilities honestly report `writeRoots: false`. MSP also
  triple-delivers approvals (request + requested + updated) and
  sometimes notification-only or choiceless — all handled (per-turn
  dedupe, listPending refetch, stale retry) and fixture-covered.
- Codex on Windows needs `danger-full-access` as the sandbox row even
  in project mode: the workspace sandbox does not contain the file
  tools but does break project shell access for non-admin users. The
  real boundary is the host approval gate (`untrusted`), which the
  matrix proved end to end. Off Windows the workspace sandbox still
  runs as defense-in-depth.
- Live-matrix environmentals (not code defects, each confirmed by the
  harness's own error, not by our verdict): claude "Credit balance
  is too low"; opencode free-tier session rejection (plus
  premiere-pro MCP sprawl, 128 tools, in the earlier run); codex
  usage-limit on the final re-run (earlier full run green).
- `tmp/` E2E evidence is now gitignored: artifacts stay on this disk
  for audit but never enter the repo (large binaries included).
- Production integrity raises the bar, it does not make cheating
  impossible: a fig-leaf visible text node over a flattened render
  passes the error (the receipt still shows one dominant unattributed
  asset and exactly 1 editable node — inspectable, not silent);
  still-image scenes never trigger (video/sequence dominance only);
  the 80% threshold is a named constant, not a derived law; and the
  `linked` role trusts absolute outside paths, which a full-machine
  agent could also write to — project-scoped agents cannot, which is
  where the two systems reinforce each other.

## Final SHA

Pending — goal continues. Interim HEAD: `8ede877`
(`fork/diffusion-on-steroids`), integrity slice complete (plan §9).
Remaining: architecture constitution (§10), remaining fire tests
(§11), packaging (§12).
