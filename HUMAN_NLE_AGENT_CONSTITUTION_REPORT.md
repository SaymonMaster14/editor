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

- NLE ops: ripple/roll/slip/slide, lift/extract, insert/overwrite, markers, I/O range,
  source monitor. No matches for these in `apps/web/src` (searched).
- Premiere keymap gaps: frame step is on A/D, arrows nudge pixels; no I/O, no edit-point
  navigation; J/K/L shuttle exists.
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

## Fire tests

Pending (see plan). Evidence will land here with artifacts under `tmp/`.

## Performance

Pending measurement on a realistic project.

## Regression

Steroids gate at starting SHA: flow-worker 10/10, present 14/14, dapi 78/78,
cli 15/15, typecheck clean (dapi/desktop/web/cli), lint 0 errors
(3 pre-existing warnings in `apps/web/src/projects/edits.ts`),
flow E2E 16/16 on the live stack, RAFT/DIS ground-truth errors 0.16/0.10px.

## Limitations

- OOM timestamps: user recalled ~02:00; crash was ~04:52 (phase-T commit 04:49).
  No work was lost: tree was clean, only the unstarted flow worker remained.
- Steroids "documentation" is commit messages + in-code docs (repo convention);
  no separate Steroids report file exists.

## Final SHA

Pending.
