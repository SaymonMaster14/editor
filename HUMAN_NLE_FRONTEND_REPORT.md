# HUMAN NLE FRONTEND REPORT — Diffusion Studio convergence

- Starting SHA: `d389d00c123761d86e9a5ecd4b7fcbfd45a7012d`
- Final SHA: `3afb81b` + fixes below — see log (branch head moves; this file tracks content, not hash)
- Branch: `diffusion-on-steroids` (pushed to `fork` remote; `origin` is read-only here: 403)
- Mission: expose the existing backend as a human NLE. No rebuilds: every item below reuses the canonical engine.

## What was already there (reused, not rebuilt)

DocumentEditor + history gestures + source sync (`apps/web/src/engine/editor.ts`, `history.ts`);
canonical NLE ops (`engine/nle.ts`: lift/extract/rippleTrimIn-Out/roll/slip/slide; `engine/split.tsx`;
`engine/source-edit.ts`: monitor + insert/overwrite; `engine/timing.ts` primitives);
markers, keyframes, audio gain/mute/pan/fades/ducking-plan, layer effects (8), transitions (5),
export, bins/relink, waveforms/thumbnails, nests (scene/sequence/group), adjustment layers,
J/K/L + I/O + `,`/`.` + M shortcuts, undo/redo, SourceMonitorPanel, asset library, Chat.

## Exposed this mission (human UI → same canonical op)

- Razor: toolbar button + `C` → `ToolType.BLADE`; click cuts via canonical `splitClipAtFrame`
  (split engine generalized to `splitOneAtFrame` in `split.tsx`; razor never drags/trims/marquee-selects).
- Q/W ripple to playhead: new canonical `rippleTrimPreviousToPlayhead` (trim head + close gap,
  snapshot-based, one gesture) + existing `rippleTrimOut`; one unit per parent (selected wins).
  `W`/`S` ±1s seek moved to `Shift+W`/`Shift+S`; plain `S` unbound.
- Shift+Delete/Backspace ripple-delete (`extract`); Alt+Arrows slide/slip;
  Rolling Edit tool (`N`) with edge-drag through canonical clamped write;
  row menu: Split at playhead, Lift, Ripple delete;
  right-click selects the row first (keeps multi-selection when inside it).
- Timeline: NLE/Compact view toggle (persisted, instant, same rows/selection/playhead/zoom);
  mute/solo/visibility; undo/redo buttons with live states + History menu
  (attributed step labels, undo/redo-to-here).
- Viewer: transport bar (prev/next edit via new `seek-edit.ts`, frame step, play, loop, timecode)
- Sidebar: Project (=Assets), Effects (8 real, apply authors canonical `<effect>`),
  Transitions (5 real, apply writes canonical whole `transition` prop),
  Search (provider fan-out in main + guarded import with provenance, sharing
  `importInternetAsset` with `assets_import`), Chat untouched.
- Agent parity (no human/agent divergence): `timeline_edit` gains `split`
  (targeted at frame, or playhead-wide) and `rippleTrimPreviousToPlayhead`; catalog + CLI help updated.

## Backend glue added (genuinely missing)

`rippleTrimPreviousToPlayhead` + `rollPairAt`/`writeRollPair` (`engine/nle.ts`),
`splitOneAtFrame`/`splitClipAtFrame` (`engine/split.tsx`), `nle-actions.tsx` human verbs,
`seek-edit.ts` edit-point nav, `applyRoll` (timeline drag), `labelStep`/`describeOps`
(`engine/history.ts`), `internet-import.ts` (shared search+import), `source-pane.tsx`,
`transport.tsx`, effects/transitions/search panels, viewer/timeline layout state.
No second engines; no shadow state; arch checker clean.

## Verification

- `tsc --noEmit` clean (web, dapi, cli, runtime); `check:architecture` PASS, 0 errors;
  `tmp/nle-e2e/proof.mjs` **33/33 green on a source dev stack** (incl. roll-refactor
  re-proof and live wikimedia search → import with full provenance).
  Workspace suites pass except `apps/desktop`, which intermittently dies on a native
  `fs-event.c` assertion inside a vitest worker — untouched by this branch
  (`git diff` empty there), environmental flake.
- Screenshots: app-window capture returns black in this session (no compositor) — no visuals attached.

## Remaining gaps (honest)

Backend-only/agent-only: tracking, stabilization, reframe, keying, segmentation, depth,
optical flow, retime maps, scopes/grade-apply (dead code), procedural FX (preview-only),
QA/integrity gates, beats/LUFS numbers, proxies (no backend at all), transcript
word-cutting, mixer. Analysis-only systems are NOT presented as production effects.
No canvas-clip right-click menu (immediate-mode canvas has no menu infra; row and
bin menus cover the ops). No track lock / source patching yet. Plain `S` intentionally unbound.


| CAPABILITY | BACKEND | FRONTEND | HUMAN TESTED | AGENT ACCESS | NOTES |
|---|---|---|---|---|---|
| timeline split/razor | split.tsx | toolbar+C+click+menu | live CLI | split op (new) | single-step undo proven |
| roll/slip/slide/move/trim | nle.ts/timing.ts | move/trim/roll-drags, Alt+Arrow slide/slip, N tool | live CLI (slip/slide/roll) | timeline_edit | roll pair/write shared by tool+DAPI |
| Q/W ripple trim | nle.ts (Q new) | Q/W keys | live CLI (Q) | both ops | W via rippleTrimOut |
| source monitor/insert/overwrite | source-edit.ts | SourceMonitorPanel + dual viewer | pre-existing | source_edit | same trait |
| markers | markers.ts | ruler+menu+M | pre-existing | marker | — |
| keyframes | keyframes.tsx | diamonds+inspector | pre-existing | keyframe | — |
| audio gain/mute/pan/fades | audio.ts | inspector+rows | pre-existing | audio_edit | ducking engine-only |
| effects (8 layer) | runtime Effect | browser+inspector | tsc only | — | procedural stack preview-only, hidden |
| transitions (5) | runtime Transition | browser+inspector | tsc only | — | — |
| color/scopes/grade | color pkg | none | no | media_scopes | grade-apply dead code |
| tracking/stabilize/reframe/key/depth/segment/flow/retime | pkgs | none | no | media_* | analysis-only, correctly unexposed |
| internet assets | providers+main IPC | Search tab (desktop) | live CLI search+import | assets_search/import | shared importInternetAsset; keyed providers need env keys |
| adjustment layers | runtime trait | inspect+render | pre-existing | — | no dedicated creator |
| text/captions | runtime+genai | text tool+caption panel | pre-existing | — | no word-cut editing |
| proxies | missing | none | no | — | no backend |
| relink/offline | library.ts | asset menu+info | pre-existing | — | — |
| export | encoder | export panel | pre-existing | export | — |
| transport/viewer modes | timing/playback | transport bar+toggle | tsc only | — | black screenshots, no visual proof |
| undo/redo | history.ts | buttons+History menu w/ labels | live CLI | timeline_edit | Human verbs + Agent ops attributed |
