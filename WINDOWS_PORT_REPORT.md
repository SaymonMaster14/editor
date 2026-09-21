# Diffusion Studio — Windows Port Report

Branch `feat/windows-parity`. Status as of 2026-09-21: all Windows
infrastructure, packaging, and no-login acceptance is implemented and verified
on the real machine. The user then logged into Diffusion Studio and the full
authenticated `dapi` pipeline (open/context/check/capture/export/probe) went
green on the installed build. A harness PATH-case discovery bug found via the user's picker screenshot
was fixed (`cb16173`) and reinstalled (08:10 build). The user then ran
the full §31 embedded-Codex session: Codex discovered with live models,
composition created, inspected via MCP capture/check, and exported —
all independently verified (see E2E). Remaining: human+agent continuity
and the E2E video.

## UPSTREAM

- Upstream repo: https://github.com/diffusionstudio/editor
- Baseline SHA (merge-base `main...HEAD`): `57c3983` (full:
  `57c39834bb3d2f116ce1d2c76cc8b881a279c2e6`)
- Baseline version: 0.205.2
- Final branch: `feat/windows-parity`
- Final SHA: `cb16173` (PATH-case discovery fix; report update committed on top as
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
  `codex-cli 0.155.0`, account `ready`, 5 live models;
  `codex login status` → `Logged in using ChatGPT` (subscription auth
  present for the embedded chat)
- Diffusion login: user-signed-in during the session (`dapi whoami` →
  authenticated user object; email redacted from this report)
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
14. The chat model picker showed Codex as "Not installed" although
    `codex.exe` was on the user PATH (user screenshot). Root cause:
    `stripElectron` copies `process.env` with OS key casing (`Path`),
    but `which()` read `host.env.PATH` — so the hydrated PATH was
    always empty in a GUI-launched app, while npm-launched probes
    worked (npm injects uppercase `PATH`, masking the bug). Added
    `envGet` (exact match, then case-insensitive scan on Windows)
    used by `which()` (`PATH`, `PATHEXT`) and `resolveBinary()`
    (overrides). POSIX behavior unchanged. (`cb16173`)

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
  long path (see below); agent-chat 45/45 (incl. 9 env-casing); dapi 36/36; winpaths 12/12.
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
- Harness env-casing tests (`packages/agent-chat/test/env.test.ts`, 9
  green): `which()`/`resolveBinary()` through mixed-case `Path` keys
  (the GUI-app case), uppercase `PATH` (npm), mixed-case `PathExt`,
  and lowercase overrides. Proven to fail without the fix (7 failed
  on stashed source, 2 behavior-neutral passed); full agent-chat
  suite 45/45, `tsc --noEmit` clean. GUI-like replication (plain `node`, env holding only `Path`): pre-fix `resolveBinary(codex)` gives null, fixed gives the installed `codex.exe` path.
- Authenticated `dapi` core on the installed build (after user login),
  project `%USERPROFILE%\Videos\Diffusion Studio\silent-sunset-20-sep`
  (1080p scene `vqq59t`, 8 s, AVC+AAC asset): `whoami` authenticated;
  `open` → structured project JSON; `context` → live state JSON;
  `check vqq59t` → `{"issues":[]}` exit 0; `capture` at 0/2/4/6 s into a
  spaced path → 3.2 MB contact sheet, probed 2576x1298 PNG; `export`
  to a spaced path → 12.7 MB MP4, config AVC 1080p + AAC; `media probe`
  of the MP4 → `avc1.640032` 2156x1080 + AAC 48 kHz stereo, 8 s, 200
  packets per track; `models` (15 entries) / `voices` (23 entries) /
  `logs` (export progress + `Export complete`) / `screenshot`
  (1184x735) all structured and live.
- Full uninstall/reinstall cycle on the installed build: `Update.exe
  --uninstall` removed the Start Menu shortcut, left 0 app processes,
  preserved `%APPDATA%\Diffusion Studio` and `Videos\` projects, and
  wiped `bin/` (user-PATH entry left dangling — restored by self-heal
  on the next app start, verified). Residue: the empty `app-0.205.2`
  dir kept 2 Squirrel leftovers, and the HKCU `diffusion://` key kept
  pointing at the removed exe (dangling until reinstall; recorded in
  KNOWN LIMITATIONS). Reinstall from the same 07:33 Setup.exe restored
  shortcut, protocol target, `bin/` self-heal, and a healthy DAPI —
  the full §24 install→uninstall→reinstall loop is green.

## EMBEDDED CHAT

- Discovery: REAL-WORLD-TESTED — `codex.exe` found via product
  `resolveBinary`, version 0.155.0 (≥ min 0.100.0).
- Auth: REAL-WORLD-TESTED at the harness level — `account/read`
  reports an account, probe status `ready` with the existing login, and
  `codex login status` confirms `Logged in using ChatGPT`. The renderer
  "ready" badge and the in-app chat session itself are NOT TESTED yet —
  the picker now lists Codex and a full chat session ran to completion
  (08:33 screenshot: GPT-5.6-Luna, tool calls + Thinking rendered).
- Models: REAL-WORLD-TESTED — live `model/list` (5 models, default
  `gpt-5.6-sol`), distinguished from the static fallback; the UI
  session ran GPT-5.6-Luna from the live list.
- Streaming / reasoning / command+file activity / MCP calls from chat
  (`media_probe`, capture, check, export) / second-turn continuity:
  REAL-WORLD-TESTED in the §31 run (transcript + verified artifacts).
  Attachments / question cards / interrupt / navigate-away /
  restart persistence+resume / teardown cleanup: IMPLEMENTED (upstream)
  but NOT REAL-WORLD-TESTED yet — persistence + no-orphan-after-exit
  are queued for the end of this session; interrupt/attachments/cards
  need dedicated UI turns.
- Claude chat: NOT TESTED DUE TO EXTERNAL ENVIRONMENT (not installed).

## EDITOR

- Window chrome: native Windows frame verified live (screenshot shows
  correct window, no transparency breakage); minimize/maximize/restore/
  close/fullscreen exercised in prior turns.
- Menu: Windows application menu implemented and unit-tested
  (`menu.test.ts`); reachable in the installed build.
- Project storage: CRUD + OneDrive short-name handling covered by
  `projects.crud.test.ts` / `projects.init.test.ts`; watcher suite passes
  (11/11, long TEMP). `dapi open` on spaced/Unicode/real project paths is
  REAL-WORLD-TESTED (structured JSON, app scaffolded `E2E Codex` on open).
  UI-level create/rename/duplicate/delete still NOT REAL-WORLD-TESTED.
- Bidirectional code↔canvas, timeline, inspector, asset library:
  IMPLEMENTED (upstream), NOT REAL-WORLD-TESTED (needs hands-on UI).
- Fonts: REAL-WORLD-TESTED via `dapi fonts` (see TESTS).
- Media tools: REAL-WORLD-TESTED (`probe/grab/filmstrip/waveform`,
  grab re-verified authenticated for E2E assets);
  `transcribe/listen` not exercised (awaiting user credit approval).
- Export/encoder: REAL-WORLD-TESTED via `dapi export` on the installed
  build — 12.7 MB MP4, AVC 2156x1080 + AAC stereo, probed track-clean
  (see TESTS). No codec fallback was copied; capability checks are
  unchanged upstream code. UI export-panel path still untested.

## PACKAGING

- Setup.exe:
  `apps/desktop/out/make/squirrel.windows/x64/Diffusion Studio-0.205.2 Setup.exe`
  (final build 2026-09-21 08:10 from `cb16173`, PATH-case discovery fix;
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
- Uninstall: full `Update.exe --uninstall` executed live — shortcut
  removed, 0 processes, user data and projects preserved, `bin/`
  wiped (PATH self-healed on next start); residues documented in TESTS
  / KNOWN LIMITATIONS. `dapi` uninstall removes only owned
  files/entries (verified live, twice). Reinstall from the same
  Setup.exe fully restored the install (see TESTS).
- Updates: compatible by construction (Squirrel versioned layout,
  official feed untouched); no live update performed (would require
  official release assets).

## E2E

LOGIN DONE — the user signed into Diffusion Studio and the whole
`dapi`-level pipeline it gates is green (see TESTS: open/context/check/
capture/export/probe on `silent-sunset-20-sep`, MP4 track-clean). What
remains is the part the agent cannot operate itself: the in-app UI.

- Project directory:
  `%USERPROFILE%\Videos\Diffusion Studio Test\E2E Codex`
  (scaffolded by the app on `dapi open`; assets `02s.png` + `clip.mp4`
  staged, prompt handed to the user)
- Prompt: §31 composition prompt (12 s, 1920x1080, background + title +
  clip + caption + motion, capture/check/fix/export loop)
- Embedded-chat run: DONE 2026-09-21 ~08:33 (model GPT-5.6-Luna,
  live discovery, not the fallback). Transcript shows `media_probe`
  + Thinking + file changes rendered; agent summary: 12 s 1920x1080
  composition from both local assets, captures at 0/1/3/5.5/8.5/11.5 s,
  final check clean, export `output/local-media-test.mp4`.
  Independently verified: `index.tsx` 8 nodes (bg, keyframed still,
  matte, clip w/ animations, accent bar, title, caption), workarea
  12 s; `dapi check` 0 issues exit 0; MP4 15.1 MB 1920x1080 12 s
  AVC + AAC stereo 48 kHz, 200 packets/track, track-clean probe.
  Screenshot of the finished chat+timeline+canvas on file (user-
  provided 08:33 capture).
- Human+agent continuity (§19): IN PROGRESS (manual title edit next,
  then same-chat follow-up)
- E2E video: PENDING (after continuity)

## KNOWN LIMITATIONS

- Embedded-chat E2E main run: DONE (see E2E). Continuity + video
  still pending the user's manual edit and follow-up turn.
- Squirrel uninstall leaves the HKCU `diffusion://` registration
  pointing at the removed exe until reinstall (upstream registers the
  protocol at runtime without an uninstall hook; same gap exists on
  macOS conceptually). Minor: 2 Squirrel leftovers stay in the emptied
  version dir.
- `npm run check`: one pre-existing upstream type error
  (`showSaveFilePicker`) fails 3 untouched workspaces.
- `npm run test`: upstream watcher suite aborts under 8.3 short-name
  TMPDIR on this machine (passes 11/11 with long TEMP); untouched files.
- Machine runs Node 26 while the mission/CI baseline is Node 20.
- Claude Code chat untested (not installed). `transcribe`/`listen`
  untested (awaiting user credit approval).
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
| Codex harness | app-server | `envGet` case fix for copied env | `env.test` 9 green | UI lists Codex; GPT-5.6-Luna ran full §31 | PASS | streaming/MCP/edit/export all live |
| Claude harness | — | unchanged | — | — | NOT TESTED | not installed |
| window chrome | hiddenInset/vibrancy | native frame | `window-chrome.test` | live screenshot 1184x735 | PASS | |
| menu | mac menu | Windows menu, no mac roles | `menu.test` | installed build | PASS | |
| deep-link | diffusion:// | registry + single-instance + pending | `deep-link.test` | full matrix (prior) | PASS | synthetic callbacks only |
| projects CRUD | Videos root | same + 8.3 OneDrive fix | crud/init tests | `dapi open` spaced/Unicode/real paths | PARTIAL | UI CRUD untested |
| watcher | fs watch | unchanged | 11/11 (long TEMP) | — | PASS* | *aborts under 8.3 TMPDIR (upstream, env-only) |
| packaged compile | staged runtime | win32-x64 runtime verified | — | 6/6 probe on installed Electron | PASS | UI recompile pending login |
| bidirectional edit | code↔canvas | unchanged | `edit.test` | — | NOT TESTED | login wall |
| fonts | JXA/NSFont | `fonts-win.ts` registry adapter | 22 + 6 green | hundreds of families live | PASS | |
| media probe/grab/film/wave | — | unchanged | — | fixtures (prior) | PASS | |
| transcribe/listen | — | unchanged | — | — | NOT TESTED | awaiting credit approval |
| capture/check/export | renderer IPC | unchanged | — | check clean, 3.2MB sheet, 12.7MB MP4 probed | PASS | via dapi on installed build |
| whoami/voices/logs/context/shot | — | unchanged | — | all live, structured, authenticated | PASS | |
| report | gh filing | unchanged + win resolution | `report.test` 7 green | unit only (by design) | PASS | |
| installer | DMG | Squirrel Setup.exe 158 MB | `packaging.test` | installed + reopened | PASS | unsigned; SmartScreen expected |
| uninstall | — | Squirrel entry + owned-files CLI removal | fixture tests | full uninstall+reinstall live | PASS | protocol key residue noted |
| updates | update-electron-app | feed untouched, safe w/o metadata | — | starts clean, no error loop | PASS | no live update (no official assets) |
| CI | mac release | `windows.yml` validate+package, Node 20 | — | check/lint/test/build run locally | PASS | GitHub run not triggered from here |
| E2E video edit+export | — | — | — | agent 8-node comp, check clean, 15MB MP4 probed | PARTIAL | continuity + video pending |

Final SHA for this report: `94ad824` + this update (committed as
`docs: record embedded-Codex E2E evidence`).
