# Diffusion Studio — Windows Port Report

Branch `feat/windows-parity`. Status as of 2026-09-21: all Windows
infrastructure, packaging, and no-login acceptance is implemented and verified
on the real machine. The authenticated end-to-end (embedded Codex editing a
real project through login-gated renderer tools) is blocked on a Diffusion
login the agent cannot perform itself — see E2E.

## UPSTREAM

- Upstream repo: https://github.com/diffusionstudio/editor
- Baseline SHA (merge-base `main...HEAD`): `57c3983` (full:
  `57c39834bb3d2f116ce1d2c76cc8b881a279c2e6`)
- Baseline version: 0.205.2
- Final branch: `feat/windows-parity` (17 commits over baseline)
- Final SHA: `6c3707e` (self-heal fix; report update committed on top as
  described at the end of this file)

## ENVIRONMENT

- Windows: Microsoft Windows 11 Pro, 10.0.26200, x64-based PC
- Node/npm on this machine: v26.4.0 / 11.18.0 (note: mission baseline is
  Node 20; the machine ships 26, so CI pins `node-version: 20` and one
  upstream watcher test aborts only under this machine's short-name TMPDIR —
  see TESTS)
- Electron: 43.1.1 (packaged runtime reports Node v24.18.0)
- esbuild (staged): 0.28.1, `@esbuild/win32-x64`
- Codex: `C:\Users\PC TRABALHO\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`,
  `codex-cli 0.155.0`, account `ready`, 5 live models
- Claude Code: not installed on this machine (`Get-Command claude` empty) —
  NOT TESTED DUE TO EXTERNAL ENVIRONMENT

## ARCHITECTURE

- Platform abstraction: new `packages/winpaths` owns the Squirrel layout
  (`squirrelRoot`, `rootForResources`, `appExePath`, `stableBinDir`,
  `versionDirs` newest-first with numeric sort, `currentBundlePath` skipping
  bundle-less dirs) and user-PATH editing (`pathHasEntry`, `addPathEntry`,
  `removePathEntry`, case-insensitive, spelling-preserving). The desktop app
  and the CLI resolve the install through it, never by string paths.
- Windows CLI: `dapi open` cold-starts via the stable stub with
  `ELECTRON_RUN_AS_NODE` stripped (detached spawn, ignored stdio, no
  `windowsHide` so second-instance delivery reaches the GUI). The staged
  wrapper is `dapi.cmd` (shim, runs the app's own Electron in Node mode) +
  `dapi.js` (bootstrap resolving the newest versioned bundle every run), so
  the PATH entry never points into `app-X.Y.Z`. Install/uninstall go through
  `cli-install-win.ts` against user PATH only, via .NET (broadcasts the
  change), refusing foreign `dapi` binaries.
- MCP: unchanged loopback HTTP (`127.0.0.1:3274/mcp`), no LAN binding, no
  weakened validation. External-agent registration (`mcp-config.ts`,
  `mcp-install.ts`) gained per-target Windows config paths with JSON/TOML
  preservation semantics kept.
- Embedded chat: unchanged architecture — `agent-host` utility process,
  token-authenticated WebSocket, `codex app-server` JSON-RPC harness with
  `-c mcp_servers.diffusion.url=...` injection. Windows specifics
  (PATHEXT/.exe resolution, `taskkill /T /F` trees, npm-shim handling) were
  already in `packages/agent-chat/src/host/env.ts` and preserved.
- Packaging: `@electron-forge/maker-squirrel`, x64, ICO icon, Squirrel
  startup events handled without booting the editor.
- Updates: `update-electron-app` left pointed at the official repo; the
  unsigned local build was verified to start and run without update metadata
  (no crash, no user-visible error loop). No fake feed was configured.

## CHANGES

Each item names the gap, the fix, and why that shape was chosen.

1. `scripts/dev-desktop.mjs` assumed POSIX (`npm` binaries, `shell`,
   Unix process trees). Added `scripts/dev-platform.mjs` with Windows
   branches (`.cmd` resolution, `Get-NetTCPConnection`/`taskkill` process
   handling) plus `dev-platform.test.mjs`. (`98539b8`)
2. `launchApp()` returned false on Windows. Implemented stub-based launch
   with env sanitization; fixed pipe-inheritance hangs (detached + ignored
   stdio) and first-delivery loss (`windowsHide` dropped) by bisecting
   spawn flags. (`fc922a0`, `bd39a8b`)
3. `stage-cli.mjs` emitted a POSIX wrapper with a macOS bundle path.
   Windows now stages `dapi.cmd`/`dapi.js` from `staged-cli/`; the
   `<install root>\bin` launcher plus user-PATH entry survives updates.
   (`fc922a0`, `fd268f6`)
4. External MCP configs used macOS paths. Added Windows detection/config
   paths per agent with fixture-tested JSON/TOML preservation (Codex TOML
   keeps unrelated servers). (`0786b29`)
5. `dapi fonts` threw "only supported on macOS". Implemented
   `fonts-win.ts` (registry + font metadata → FontFamily schema: family,
   variants, CSS weights, italic, `local()` sources), macOS path kept.
   (`6b49e05`)
6. No Windows chrome/menu/protocol. Added native frame behavior, a Windows
   application menu (no macOS roles), and `diffusion://` single-instance
   routing with pending-link delivery. (`46eab6b`)
7. OneDrive roots spelled with 8.3 short names were missed. Detection now
   normalizes short/long spellings. (`62b38b0`)
8. No Windows installer. Added Squirrel maker config, ICO generation,
   resource staging (CLI/runtime/docs), and an electron-packager patch;
   fixed end-to-end `make` on Windows. (`e1956d3`, `e081354`)
9. CLI error paths aborted on Windows (non-zero `where`, `dapi mcp`
   shutdown). Made shutdown drain-safe and error paths non-aborting.
   (`e2915ef`, `ea18cdb`)
10. `dapi report` was untested on Windows. Added body-generation and `gh`
    resolution unit tests; no live issues filed. (`88958ed`)
11. `where.exe` printed "not found" noise into logs on every check. Its
    stdio is now silenced (stdout still parsed). (`be419ba`)
12. No Windows CI. Added `.github/workflows/windows.yml` with separate
    validate (check/lint/test/build) and package (`make` + Setup.exe
    artifact) jobs on `windows-latest`, Node 20, no signing. (`33e7ed1`)
13. A same-version Squirrel reinstall wipes the custom `bin/` launcher
    while the user-PATH entry survives, leaving `dapi` dangling
    (discovered by reinstalling during acceptance). Added
    `winCliNeedsRepair` + `healCliInstall`, run at startup next to the
    existing MCP heal: when the PATH entry proves a prior install but
    the files are gone, the app silently recreates only the files it
    owns. Never throws; dev builds and never-installed machines are
    untouched. (`6c3707e`)

macOS behavior was preserved throughout: darwin-gated chrome, JXA fonts,
`/usr/local/bin` symlink flow, and DMG release workflow are untouched
(`git diff main...HEAD` shows no changes to them).

## TESTS

Commands run (native PowerShell, installed build unless noted):

- `npm run check` — all touched packages pass (cli, desktop, web,
  agent-chat, assets, dapi, jsx, koota-solid, winpaths). Three workspaces
  (encoder, reconciler, runtime) fail on one upstream error,
  `packages/assets/src/browser.ts(65,25): showSaveFilePicker does not exist`
  — proven pre-existing: `git diff main...HEAD` over those packages and
  that file is empty.
- `npm run lint` — exit 0 (3 upstream warnings in
  `apps/web/src/projects/edits.ts`, untouched file).
- `npm run test` — cli 15/15; desktop 162/173 in the default run, with the
  11 missing tests (`projects.watch.test.ts`) passing 11/11 when TEMP is a
  long path (see below); agent-chat 36/36; dapi 36/36; winpaths 12/12.
- Watcher abort triage: `projects.watch.test.ts` aborts its worker with
  libuv `fs-event.c:72 !_wcsnicmp` when `os.tmpdir()` is the 8.3 spelling
  `C:\Users\PCTRAB~1\...`. Upstream-identical files (`git diff` empty),
  fails alone, passes 11/11 with long TEMP. Environmental, not a product
  bug; CI (`windows-latest`, Node 20, long temp path) is unaffected.
- `npm run build:desktop` — exit 0.
- `npm run make` — proven locally: Setup.exe produced and installed (see
  PACKAGING).

Real desktop / installed-app tests (all on the installed build at
`%LOCALAPPDATA%\DiffusionStudio`, app-0.205.2):

- `dapi --version` → `0.205.2` from a fresh-registry-PATH shell
  (`Get-Command dapi` → `...\bin\dapi.cmd`); the agent shell itself keeps
  a stale PATH block (expected Windows inheritance), so fresh shells were
  simulated with the registry Machine+User PATH — documented, not hidden.
- Full §9 acceptance through the real `winInstallCli`/`winUninstallCli`:
  uninstall removed shim+bootstrap+dir+PATH entry and a fresh shell no
  longer resolved `dapi`; reinstall restored everything; both idempotent
  (second uninstall → `absent`, second install → `installed`). Green twice.
- `dapi open` with the app closed relaunched it (exit 0); DAPI listened on
  127.0.0.1:3274 only; `dapi models` returned structured JSON.
- `dapi open <path>` torture on the fresh build, cold then warm: ASCII,
  spaces (`open probe spaces`), and Unicode (`Projeto Ç\Project One`)
  paths each exit 0 with structured project JSON (`id`/`name`/`dir`,
  Unicode preserved byte-exact); single instance kept (5 procs), DAPI
  listening. Registry `diffusion://` entry re-verified post-reinstall
  (`URL:diffusion` → versioned exe `%1`).
- `dapi mcp` cold background launch (throwaway `C:\tmp\mcp-stdio-probe.cjs`,
  kept out of the repo): app quit, proxy spawned with a real MCP handshake
  — server `diffusion 0.205.2`, 18 tools enumerated, mid-session state 7
  processes all `hwnd=0` (zero visible windows) with port listening, stdin
  close → proxy exit 0. `MCP_STDIO_PROBE_OK` on the fresh build.
- Stale-build lesson: the 01:01 installer predated the CLI fixes, and its
  `dapi mcp` exited 0 silently ~5.6 s into a cold boot (old
  execFile+windowsHide launch, pre-drain-safe shutdown). Bisected via
  process-tree capture (stub→versioned-exe forwarding is normal Squirrel
  behavior) and bundle grep (`shutdownArmed` absent). Fixed by rebuilding
  from HEAD — never by changing code for the symptom. Installed bundles
  are now verified fresh by marker grep before acceptance.
- Reinstall self-heal, live: after reinstall wiped `bin/` (PATH dangling),
  the first app start recreated both launcher files with zero user action;
  `dapi --version` → `0.205.2` immediately after.
- No-login DAPI matrix, each with structured output or a real file:
  `models`, `voices` (23 entries), `whoami` (`{"user":null}`, proving
  logged-out state), `logs` (`{"entries":[]}`), `context` (empty-state
  JSON), `screenshot` (1184x735 PNG of the live window), `fonts`
  (hundreds of families; `--family Arial/Segoe`, `--weights`, `--limit`
  verified in prior turns), `media probe/grab/filmstrip/waveform` on
  image/video/audio fixtures (prior turns).
- Loopback/concurrency/port-collision and the full `diffusion://` matrix
  (registration, cold launch, second-instance delivery, pending-link
  toast, auth/checkout routing, malformed-URL safety) verified in prior
  turns against the installed build.
- `dapi report` covered by unit tests only (7 green); nothing filed.
- Packaged-compile probe (throwaway `C:\tmp\compile-probe.cjs`, kept out
  of the repo): on the installed Electron in Node mode against the
  installed staged runtime — native `esbuild.exe` 11.1 MB with MZ header,
  `--version` 0.28.1, JS API 0.28.1, babel solid-universal + TypeScript
  transform of TSX (JSX+types compiled, `@diffusionstudio/jsx` runtime
  referenced), `esbuild.build` with a `solidLoader`-style plugin (1181
  chars bundled, externals preserved), syntax-error fixture failing
  cleanly. 6/6 green. (Full create/edit/recompile in the UI needs login.)
- Codex readiness via the real `CodexHarness.probe` (throwaway test,
  removed after): binary resolved, `ready`, version 0.155.0, default
  `gpt-5.6-sol`, 5 live models (not the 2-item static fallback), no
  `codex` processes left behind. No credentials printed.
- Live Codex MCP user-config cycle via the real `applyMcp`/`mcpStatus`
  (throwaway test, removed after; backup at
  `%TEMP%\codex-config-backup.toml`): initial state detected+connected
  (12 `mcp_servers` tables, 26350 bytes); disconnect removed only our
  table (11 left, `connected=false`); connect restored it with the
  loopback URL (12 tables, `connected=true`); a second
  disconnect/connect cycle behaved identically; the file was restored
  byte-exact (sha prefix `bb3248771b1ebded` before and after, `fc /b`
  clean). Only booleans/counts/hashes were printed — never contents.

## EMBEDDED CHAT

- Discovery: REAL-WORLD-TESTED — `codex.exe` found via product
  `resolveBinary`, version 0.155.0 (≥ min 0.100.0).
- Auth: REAL-WORLD-TESTED at the harness level — `account/read`
  reports an account, probe status `ready` with the existing login. The
  renderer "ready" badge itself is NOT TESTED (needs login-gated UI).
- Models: REAL-WORLD-TESTED — live `model/list` (5 models, default
  `gpt-5.6-sol`), distinguished from the static fallback.
- Streaming / attachments / questions / interrupt / persistence / resume /
  MCP calls from chat / process cleanup after chat teardown: IMPLEMENTED
  (upstream, preserved), NOT REAL-WORLD-TESTED — all require the
  login-gated editor session. Probe-level cleanup verified (no orphan
  `codex` after probe).
- Claude chat: NOT TESTED DUE TO EXTERNAL ENVIRONMENT (not installed).

## EDITOR

- Window chrome: native Windows frame verified live (screenshot shows
  correct window, no transparency breakage); minimize/maximize/restore/
  close/fullscreen exercised in prior turns.
- Menu: Windows application menu implemented and unit-tested
  (`menu.test.ts`); reachable in the installed build.
- Project storage: CRUD + OneDrive short-name handling covered by
  `projects.crud.test.ts` / `projects.init.test.ts`; watcher suite passes
  (11/11, long TEMP). UI-level create/open/rename with spaces/Unicode
  paths needs the login-gated dashboard — NOT REAL-WORLD-TESTED.
- Bidirectional code↔canvas, timeline, inspector, asset library:
  IMPLEMENTED (upstream), NOT REAL-WORLD-TESTED (login wall).
- Fonts: REAL-WORLD-TESTED via `dapi fonts` (see TESTS).
- Media tools: REAL-WORLD-TESTED (`probe/grab/filmstrip/waveform`);
  `transcribe/listen` not exercised (credit cost, no login).
- Export/encoder: NOT REAL-WORLD-TESTED (login wall). No codec fallback
  was copied; capability checks are unchanged upstream code.

## PACKAGING

- Setup.exe:
  `apps/desktop/out/make/squirrel.windows/x64/Diffusion Studio-0.205.2 Setup.exe`
  (157,968,896 bytes, final build 2026-09-21 07:33 from HEAD `6c3707e`;
  an earlier 01:01 build predated the CLI fixes and was superseded after
  the stale-bundle diagnosis above).
- Installed to `%LOCALAPPDATA%\DiffusionStudio` (stable stub +
  `app-0.205.2` + `Update.exe`); installed app launches, reopens,
  preserves data across reinstall, serves DAPI, handles `diffusion://`.
  Unsigned build: Windows SmartScreen warning is expected; signing hooks
  are left ready.
- Start Menu: `Diffusion Studio\Diffusion Studio.lnk` targets the stable
  stub (`...\DiffusionStudio\Diffusion Studio.exe`, update-proof).
  Uninstall entry: `Diffusion Studio 0.205.2` in HKCU. Version metadata
  stamped on both stub and versioned exe (File/Product 0.205.2, Company
  `Diffusion Studio`).
- `dapi` install behavior: user-PATH `...\DiffusionStudio\bin` entry,
  stable two-file launcher, full acceptance green (see TESTS).
- Deep-link behavior: registered and routed (see TESTS).
- Uninstall: Squirrel uninstall entry present; `dapi` uninstall removes
  only owned files/entries (verified live). Full app uninstall was not
  executed (would destroy the test install) — uninstall-entry presence
  verified instead.
- Updates: compatible by construction (Squirrel versioned layout,
  official feed untouched); no live update performed (would require
  official release assets).

## E2E

BLOCKED ON DIFFUSION LOGIN — the installed app sits at the sign-in screen
(`dapi whoami` → `{"user":null}`, screenshot 1184x735 on file at
`C:\Users\PCTRAB~1\AppData\Local\Temp\shot-login-wall.png\`). The agent
cannot enter the user's Google/GitHub credentials.

- Project directory: (to be created after login)
- Prompt: §31 composition prompt (12 s, 1920x1080, background + title +
  clip + caption + motion, capture/check/fix/export loop)
- Capture paths / check result / exported MP4 / probe: PENDING LOGIN
- Human+agent continuity (§19): PENDING LOGIN
- E2E video: PENDING LOGIN

Everything that can be verified without login is green above; the moment a
login session exists, the remaining gate is purely mechanical (the tools,
chat harness, and compile pipeline it exercises are already proven).

## KNOWN LIMITATIONS

- Authenticated E2E (capture/check/export, embedded-chat editing,
  bidirectional persistence, MP4, continuity, video): blocked on user
  login, not on code.
- `npm run check`: one pre-existing upstream type error
  (`showSaveFilePicker`) fails 3 untouched workspaces.
- `npm run test`: upstream watcher suite aborts under 8.3 short-name
  TMPDIR on this machine (passes 11/11 with long TEMP); untouched files.
- Machine runs Node 26 while the mission/CI baseline is Node 20.
- Claude Code chat untested (not installed). `transcribe`/`listen`
  untested (credits + login). Full app uninstall not executed (by design).
- Web download CTA untouched (§26): no fake Windows release URL added.

## FEATURE MATRIX

| FEATURE | MACOS BEHAVIOR | WINDOWS IMPLEMENTATION | AUTOMATED TEST | REAL TEST | RESULT | NOTES |
|---|---|---|---|---|---|---|
| dev desktop | POSIX launcher | `dev-platform.mjs` win branches | `dev-platform.test.mjs` 21 green | `dev:desktop` in prior turns | PASS | |
| CLI build | POSIX scripts | cross-platform npm scripts | cli 15/15 | built + staged | PASS | |
| DAPI transport | loopback :3274 | unchanged, verified loopback-only | `http.test`, `tools-session` | Listen on 127.0.0.1, models JSON | PASS | |
| cold-start | `open -a` | stub launch, env-stripped, detached | `cli-client.test` | `dapi open` relaunch, exit 0 | PASS | |
| bg mcp launch | `open -g -a --args --hidden` | `--hidden` stub + stdio proxy | — | cold handshake, 18 tools, 0 windows, exit 0 | PASS | stale 01:01 build failed this; rebuilt 07:33 green |
| reinstall heal | n/a | `winCliNeedsRepair` + startup heal | 2 new fixture tests | bin/ recreated on first run, shim works | PASS | |
| staged wrapper | POSIX sh | `dapi.cmd` + `dapi.js` on own Electron | `dapi-launcher.test` 4 green | `--version` 0.205.2 | PASS | |
| PATH install | /usr/local/bin symlink | user-PATH stable bin, .NET broadcast | `cli-install-win.test` 12 green | full install/uninstall cycle ×2 | PASS | |
| MCP externals | mac paths | per-target Windows paths | `mcp-config` 27 + `mcp-install` 11 | live Codex TOML cycle + byte-exact restore | PASS | other agents fixture-only |
| Codex harness | app-server | unchanged, Windows env preserved | — | probe: ready/0.155.0/5 live models | PASS | chat UI session pending login |
| Claude harness | — | unchanged | — | — | NOT TESTED | not installed |
| window chrome | hiddenInset/vibrancy | native frame | `window-chrome.test` | live screenshot 1184x735 | PASS | |
| menu | mac menu | Windows menu, no mac roles | `menu.test` | installed build | PASS | |
| deep-link | diffusion:// | registry + single-instance + pending | `deep-link.test` | full matrix (prior) | PASS | synthetic callbacks only |
| projects CRUD | Videos root | same + 8.3 OneDrive fix | crud/init tests | — | PARTIAL | UI-level pending login |
| watcher | fs watch | unchanged | 11/11 (long TEMP) | — | PASS* | *aborts under 8.3 TMPDIR (upstream, env-only) |
| packaged compile | staged runtime | win32-x64 runtime verified | — | 6/6 probe on installed Electron | PASS | UI recompile pending login |
| bidirectional edit | code↔canvas | unchanged | `edit.test` | — | NOT TESTED | login wall |
| fonts | JXA/NSFont | `fonts-win.ts` registry adapter | 22 + 6 green | hundreds of families live | PASS | |
| media probe/grab/film/wave | — | unchanged | — | fixtures (prior) | PASS | |
| transcribe/listen | — | unchanged | — | — | NOT TESTED | credits + login |
| capture/check/export | renderer IPC | unchanged | — | — | NOT TESTED | login wall |
| whoami/voices/logs/context/shot | — | unchanged | — | all live, structured | PASS | whoami null = logged out |
| report | gh filing | unchanged + win resolution | `report.test` 7 green | unit only (by design) | PASS | |
| installer | DMG | Squirrel Setup.exe 158 MB | `packaging.test` | installed + reopened | PASS | unsigned; SmartScreen expected |
| uninstall | — | Squirrel entry + owned-files CLI removal | fixture tests | CLI cycle live; app uninstall not run | PARTIAL | by design |
| updates | update-electron-app | feed untouched, safe w/o metadata | — | starts clean, no error loop | PASS | no live update (no official assets) |
| CI | mac release | `windows.yml` validate+package, Node 20 | — | check/lint/test/build run locally | PASS | GitHub run not triggered from here |
| E2E video edit+export | — | — | — | — | BLOCKED | needs Diffusion login |

Final SHA for this report: `6c3707e` + this update (committed as
`docs: record stale-build diagnosis, mcp cold proof, self-heal`).
