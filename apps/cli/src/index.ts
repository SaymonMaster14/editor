#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { version } from "../../../package.json";
import { MCP_URL, toolByName } from "@diffusionstudio/dapi";
import { APP_NAME, appError, call, fail, failSync, launchApp, ping, waitForApp } from "./cli-client";
import { runProxy } from "./mcp-proxy";

import type { GenericTool, ToolInput, ToolName } from "@diffusionstudio/dapi";

/** The tool's description, verbatim. */
function describe(name: ToolName): string {
  return toolByName(name).description;
}

/** An input field's description, verbatim, for the option that maps onto it. */
function field(name: ToolName, key: string): string {
  const tool: GenericTool = toolByName(name);
  const schema = tool.input.shape[key];
  if (schema === undefined) throw new Error(`tool ${name} has no input field "${key}"`);
  return schema.description ?? "";
}

/**
 * Checks the input against the tool's schema, calls the tool, and prints
 * what the app returns — its structured content, as one JSON object, the
 * same thing an agent receives. Strings stay strings: times like "45f" are
 * parsed by the schema on both sides.
 */
async function run<N extends ToolName>(name: N, input: ToolInput<N>): Promise<void> {
  const parsed = toolByName(name).input.safeParse(input);
  if (!parsed.success) return fail(z.prettifyError(parsed.error));
  const output = await call(name, input).catch(appError);
  console.log(JSON.stringify(output));
}

// Numbers are converted so the schema can check them as numbers; an empty or
// non-numeric string becomes NaN, which the schema rejects with its own message.
const numeric = (value: string): number => (value.trim() === "" ? NaN : Number(value));

/**
 * One --effect spec: `grain`, or `kind:param=value,...` — e.g.
 * `shake:amplitude=6,frequency=8`. Non-numeric values become NaN so the
 * tool schema rejects them with its own message; malformed specs fail here.
 */
function effectSpec(value: string): { kind: string; params?: Record<string, number> } {
  const [kind, rest] = value.split(/:(.*)/s) as [string, string | undefined];
  if (!kind || kind.trim() === "") throw new InvalidArgumentError(`expected kind or kind:param=value,... (got "${value}")`);
  if (rest === undefined) return { kind };
  const params: Record<string, number> = {};
  for (const pair of rest.split(",")) {
    const [key, raw] = pair.split("=");
    if (!key || key.trim() === "" || raw === undefined) {
      throw new InvalidArgumentError(`expected kind:param=value,... (got "${value}")`);
    }
    params[key] = numeric(raw);
  }
  return { kind, params };
}

/**
 * A local file (or frames folder) that exists is sent as its absolute path;
 * anything else — a URL, or a library path (`b-roll/clip.mp4`) — is passed
 * through for the app to resolve. Library paths need an open project.
 */
function assetPath(ref: string): string {
  const abs = resolve(ref);
  if (existsSync(abs)) return abs;
  if (isAbsolute(ref)) failSync(`File not found: ${abs}`);
  return ref;
}

const program = new Command();

program
  .name("dapi")
  .description(
    `The Diffusion Studio CLI: understand, generate, and edit footage.
Analyze video/audio/images, generate them with AI, and compose assets.
Use for any media analysis, media generation, or video editing task. No ffmpeg needed.`)
  .version(version);

program
  .command("open")
  .description(
    `Launch ${APP_NAME} (or surface the running instance) and, given a path, open that folder as a project, creating the project files if the folder is not one yet. Prints the project's id, display name, and folder. Run this once before commands that need an open project (capture, check, export, context, and library paths in media commands).`,
  )
  .argument("[path]", `${field("open", "dir")} (default: none — just launch the app)`)
  .option("-b, --background", "launch or keep the app in the background, without raising a window")
  .action(async (path: string | undefined, opts: { background?: boolean }) => {
    const launched = await launchApp(opts.background ?? false);
    await (launched ? waitForApp() : ping()).catch(appError);
    if (path !== undefined) await run("open", { dir: resolve(path) });
  });

program
  .command("mcp")
  .description(
    `Serve ${APP_NAME}'s MCP server over stdio, for agents that cannot connect to it by URL (Claude Desktop). Launches the app in the background if it is not running. Agents that speak Streamable HTTP should use ${MCP_URL} directly.`,
  )
  .action(() => runProxy().catch(appError));

program
  .command("context")
  .alias("ctx")
  .description(describe("context"))
  .action(() => run("context", {}));

program
  .command("capture")
  .description(describe("capture"))
  .argument("<id>", field("capture", "id"))
  .option("-t, --times <time...>", field("capture", "times"))
  .option("-S, --separate", field("capture", "separate"))
  .option("--per-sheet <n>", field("capture", "perSheet"), numeric)
  .option("-o, --output <dir>", field("capture", "output"))
  .action((id: string, opts: Omit<ToolInput<"capture">, "id">) =>
    run("capture", { id, ...opts, output: opts.output && resolve(opts.output) }),
  );

program
  .command("export")
  .description(describe("export"))
  .argument("<id>", field("export", "id"))
  .argument("[output]", field("export", "path"))
  .action((id: string, output: string | undefined) => run("export", { id, path: output && resolve(output) }));

program
  .command("check")
  .description(`${describe("check")} Exits 1 when an error-severity issue is found.`)
  .argument("<id>", field("check", "id"))
  .action(async (id: string) => {
    const output = await call("check", { id }).catch(appError);
    console.log(JSON.stringify(output));
    if (output.issues.some((issue) => issue.severity === "error")) process.exitCode = 1;
  });

program
  .command("timeline")
  .description(describe("timeline_edit"))
  .argument("<op>", "lift, extract, rippleTrimIn, rippleTrimOut, roll, slip, slide, move, trimIn, trimOut, undo, redo, or list")
  .argument("[target]", field("timeline_edit", "target"))
  .option("--frame <n>", field("timeline_edit", "frame"), numeric)
  .option("--delta <n>", field("timeline_edit", "delta"), numeric)
  .option("--targets <ids>", "extra comma-separated node ids for multi-target lift/extract")
  .action((op: ToolInput<"timeline_edit">["op"], target: string | undefined, opts: { frame?: number; delta?: number; targets?: string }) =>
    run("timeline_edit", {
      op,
      ...(target ? { target } : {}),
      ...(opts.frame !== undefined ? { frame: opts.frame } : {}),
      ...(opts.delta !== undefined ? { delta: opts.delta } : {}),
      ...(opts.targets ? { targets: opts.targets.split(",").map((id) => id.trim()).filter(Boolean) } : {}),
    }),
  );
program
  .command("source")
  .description(describe("source_edit"))
  .argument("<op>", "load, markIn, markOut, scrub, insert, overwrite, or range")
  .argument("[asset]", field("source_edit", "asset"))
  .option("--at <time>", field("source_edit", "at"))
  .option("--in <time>", field("source_edit", "in"))
  .option("--out <time>", field("source_edit", "out"))
  .option("--frame <n>", field("source_edit", "frame"), numeric)
  .option("--parent <id>", field("source_edit", "parent"))
  .action((
    op: ToolInput<"source_edit">["op"],
    asset: string | undefined,
    opts: { at?: string; in?: string; out?: string; frame?: number; parent?: string },
  ) =>
    run("source_edit", {
      op,
      ...(asset ? { asset } : {}),
      ...(opts.at !== undefined ? { at: opts.at } : {}),
      ...(opts.in !== undefined ? { in: opts.in } : {}),
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      ...(opts.frame !== undefined ? { frame: opts.frame } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
    }),
  );
program
  .command("qa-sweep")
  .alias("qa")
  .description(`${describe("qa_sweep")} Exits 1 when an error-severity finding is recorded.`)
  .argument("<id>", field("qa_sweep", "id"))
  .option("-m, --mode <mode>", field("qa_sweep", "mode"))
  .option("-n, --max-frames <n>", field("qa_sweep", "maxFrames"), numeric)
  .option("-t, --times <time...>", field("qa_sweep", "times"))
  .option("-S, --separate", field("qa_sweep", "separate"))
  .option("--per-sheet <n>", field("qa_sweep", "perSheet"), numeric)
  .option("-o, --output <dir>", field("qa_sweep", "output"))
  .action(async (id: string, opts: Omit<ToolInput<"qa_sweep">, "id">) => {
    const output = await call("qa_sweep", { id, ...opts, output: opts.output && resolve(opts.output) }).catch(appError);
    console.log(JSON.stringify(output));
    if (output.receipt.receipt.stats.errors > 0) process.exitCode = 1;
  });


const media = program
  .command("media")
  .alias("m")
  .description(
    "Inspect a media file by path, without adding it to the project: probe metadata, transcribe speech, grab frames, render visual previews, and analyze with multimodal models. Local files work with or without an open project; library paths need one.",
  );

media
  .command("probe")
  .description(describe("media_probe"))
  .argument("<path>", field("media_probe", "path"))
  .action((ref: string) => run("media_probe", { path: assetPath(ref) }));

media
  .command("loudness")
  .alias("lufs")
  .description(describe("audio_loudness"))
  .argument("<path>", field("audio_loudness", "path"))
  .option("-t, --target <lufs>", field("audio_loudness", "targetLUFS"), numeric)
  .action((ref: string, opts: Omit<ToolInput<"audio_loudness">, "path">) =>
    run("audio_loudness", { path: assetPath(ref), ...opts }),
  );

media
  .command("beats")
  .description(describe("audio_beats"))
  .argument("<path>", field("audio_beats", "path"))
  .option("--min-bpm <bpm>", field("audio_beats", "minBpm"), numeric)
  .option("--max-bpm <bpm>", field("audio_beats", "maxBpm"), numeric)
  .action((ref: string, opts: Omit<ToolInput<"audio_beats">, "path">) =>
    run("audio_beats", { path: assetPath(ref), ...opts }),
  );

media
  .command("scenes")
  .description(describe("media_scenes"))
  .argument("<path>", field("media_scenes", "path"))
  .option("--threshold <n>", field("media_scenes", "threshold"), numeric)
  .option("--min-shot <s>", field("media_scenes", "minShotSeconds"), numeric)
  .action((ref: string, opts: { threshold?: number; minShot?: number }) =>
    run("media_scenes", {
      path: assetPath(ref),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.minShot !== undefined ? { minShotSeconds: opts.minShot } : {}),
    }),
  );

media
  .command("track")
  .description(describe("media_track"))
  .argument("<path>", field("media_track", "path"))
  .option("-t, --time <s>", field("media_track", "time"), numeric)
  .option("--x <n>", field("media_track", "x"), numeric)
  .option("--y <n>", field("media_track", "y"), numeric)
  .option("--width <n>", field("media_track", "width"), numeric)
  .option("--height <n>", field("media_track", "height"), numeric)
  .option("--search-radius <px>", field("media_track", "searchRadius"), numeric)
  .option("--lost-threshold <n>", field("media_track", "lostThreshold"), numeric)
  .action(
    (
      ref: string,
      opts: { time?: number; x: number; y: number; width: number; height: number; searchRadius?: number; lostThreshold?: number },
    ) => run("media_track", { path: assetPath(ref), ...opts }),
  );

media
  .command("stabilize")
  .description(describe("media_stabilize"))
  .argument("<path>", field("media_stabilize", "path"))
  .option("--patches <n>", field("media_stabilize", "patches"), numeric)
  .option("--patch-size <px>", field("media_stabilize", "patchSize"), numeric)
  .option("--search-radius <px>", field("media_stabilize", "searchRadius"), numeric)
  .option("--smoothing <n>", field("media_stabilize", "smoothing"), numeric)
  .action(
    (ref: string, opts: { patches?: number; patchSize?: number; searchRadius?: number; smoothing?: number }) =>
      run("media_stabilize", { path: assetPath(ref), ...opts }),
  );

media
  .command("reframe")
  .description(describe("media_reframe"))
  .argument("<path>", field("media_reframe", "path"))
  .argument("<aspect>", field("media_reframe", "aspect"))
  .option("--smoothing <n>", field("media_reframe", "smoothing"), numeric)
  .option("--cuts <t...>", field("media_reframe", "cuts"), numeric)
  .action(
    (ref: string, aspect: string, opts: { smoothing?: number; cuts?: number[] }) =>
      run("media_reframe", { path: assetPath(ref), aspect, ...opts }),
  );

media
  .command("key")
  .description(describe("media_key"))
  .argument("<path>", field("media_key", "path"))
  .option("--screen <rgb>", field("media_key", "screen"))
  .option("--tolerance <n>", field("media_key", "tolerance"), numeric)
  .option("--softness <n>", field("media_key", "softness"), numeric)
  .action((ref: string, opts: { screen?: string; tolerance?: number; softness?: number }) =>
    run("media_key", {
      path: assetPath(ref),
      ...(opts.screen !== undefined ? { screen: opts.screen.split(",").map(numeric) as [number, number, number] } : {}),
      ...(opts.tolerance !== undefined ? { tolerance: opts.tolerance } : {}),
      ...(opts.softness !== undefined ? { softness: opts.softness } : {}),
    }),
  );

media
  .command("retime")
  .description(describe("media_retime"))
  .argument("<path>", field("media_retime", "path"))
  .option("--fps <n>", field("media_retime", "fps"), numeric)
  .option("--speed <n>", field("media_retime", "speed"), numeric)
  .option("--reverse", field("media_retime", "reverse"))
  .option("--freeze <at,hold...>", field("media_retime", "freeze"))
  .option("--ramp <time,speed...>", field("media_retime", "ramp"))
  .action(
    (
      ref: string,
      opts: { fps?: number; speed?: number; reverse?: boolean; freeze?: string[]; ramp?: string[] },
    ) =>
      run("media_retime", {
        path: assetPath(ref),
        ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
        ...(opts.reverse !== undefined ? { reverse: opts.reverse } : {}),
        ...(opts.freeze !== undefined
          ? { freeze: opts.freeze.map((pair) => {
              const [at, hold] = pair.split(",").map(numeric);
              return { at: at as number, hold: hold as number };
            }) }
          : {}),
        ...(opts.ramp !== undefined
          ? { ramp: opts.ramp.map((pair) => {
              const [time, speed] = pair.split(",").map(numeric);
              return { time: time as number, speed: speed as number };
            }) }
          : {}),
      }),
  );

media
  .command("scopes")
  .description(describe("media_scopes"))
  .argument("<path>", field("media_scopes", "path"))
  .action((ref: string) => run("media_scopes", { path: assetPath(ref) }));

media
  .command("transcribe")
  .description(describe("media_transcribe"))
  .argument("<path>", field("media_transcribe", "path"))
  .option("-o, --output <path>", field("media_transcribe", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_transcribe">, "path">) =>
    run("media_transcribe", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("grab")
  .alias("sample")
  .description(describe("media_grab"))
  .argument("<path>", field("media_grab", "path"))
  .option("-t, --times <time...>", field("media_grab", "times"))
  .option("-c, --count <n>", field("media_grab", "count"), numeric)
  .option("-a, --auto", field("media_grab", "auto"))
  .option("-s, --start <time>", field("media_grab", "start"))
  .option("-e, --end <time>", field("media_grab", "end"))
  .option("-q, --quality <preset>", field("media_grab", "quality"))
  .option("-S, --separate", field("media_grab", "separate"))
  .option("--per-sheet <n>", field("media_grab", "perSheet"), numeric)
  .option("--uncapped", field("media_grab", "uncapped"))
  .option("-o, --output <dir>", field("media_grab", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_grab">, "path">) =>
    run("media_grab", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("effects")
  .alias("fx")
  .description(describe("media_effects"))
  .argument("<path>", field("media_effects", "path"))
  .option("--effect <spec>", `${field("media_effects", "effects")} Repeat for a stack: --effect grain:amount=12 --effect vignette:strength=0.5`, (value: string, acc: Array<ReturnType<typeof effectSpec>>) => acc.concat([effectSpec(value)]), [] as Array<ReturnType<typeof effectSpec>>)
  .option("-t, --times <time...>", field("media_effects", "times"))
  .option("-c, --count <n>", field("media_effects", "count"), numeric)
  .option("-s, --start <time>", field("media_effects", "start"))
  .option("-e, --end <time>", field("media_effects", "end"))
  .option("-q, --quality <preset>", field("media_effects", "quality"))
  .option("-S, --separate", field("media_effects", "separate"))
  .option("--per-sheet <n>", field("media_effects", "perSheet"), numeric)
  .option("-o, --output <dir>", field("media_effects", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_effects">, "path" | "effects"> & { effect?: Array<{ kind: string; params?: Record<string, number> }> }) => {
    const { effect, ...rest } = opts;
    // Kinds stay strings here; run() checks them against the tool schema.
    const effects = (effect ?? []) as ToolInput<"media_effects">["effects"];
    return run("media_effects", {
      path: assetPath(ref),
      ...rest,
      effects,
      output: rest.output && resolve(rest.output),
    });
  });

media
  .command("segment")
  .alias("seg")
  .description(describe("media_segment"))
  .argument("<path>", field("media_segment", "path"))
  .option("-t, --time <s>", field("media_segment", "time"), numeric)
  .option("--classes <name...>", field("media_segment", "classes"))
  .option("--conf <n>", field("media_segment", "conf"), numeric)
  .option("-o, --output <dir>", field("media_segment", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_segment">, "path">) =>
    run("media_segment", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("depth")
  .description(describe("media_depth"))
  .argument("<path>", field("media_depth", "path"))
  .option("-t, --time <s>", field("media_depth", "time"), numeric)
  .option("-o, --output <dir>", field("media_depth", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_depth">, "path">) =>
    run("media_depth", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("flow")
  .description(describe("media_flow"))
  .argument("<path>", field("media_flow", "path"))
  .option("-t, --time <s>", field("media_flow", "time"), numeric)
  .option("-d, --dt <s>", field("media_flow", "dt"), numeric)
  .option("-e, --engine <name>", field("media_flow", "engine"))
  .option("-o, --output <dir>", field("media_flow", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_flow">, "path">) =>
    run("media_flow", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("filmstrip")
  .alias("film")
  .description(describe("media_filmstrip"))
  .argument("<path>", field("media_filmstrip", "path"))
  .option("-s, --start <time>", field("media_filmstrip", "start"))
  .option("-e, --end <time>", field("media_filmstrip", "end"))
  .option("-x, --scale <factor>", field("media_filmstrip", "scale"), numeric)
  .option("-o, --output <path>", field("media_filmstrip", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_filmstrip">, "path">) =>
    run("media_filmstrip", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("waveform")
  .alias("wave")
  .description(describe("media_waveform"))
  .argument("<path>", field("media_waveform", "path"))
  .option("-s, --start <time>", field("media_waveform", "start"))
  .option("-e, --end <time>", field("media_waveform", "end"))
  .option("-x, --scale <factor>", field("media_waveform", "scale"), numeric)
  .option("-o, --output <path>", field("media_waveform", "output"))
  .action((ref: string, opts: Omit<ToolInput<"media_waveform">, "path">) =>
    run("media_waveform", { path: assetPath(ref), ...opts, output: opts.output && resolve(opts.output) }),
  );

media
  .command("listen")
  .description(describe("media_listen"))
  .argument("<path>", field("media_listen", "path"))
  .option("-p, --prompt <str>", field("media_listen", "prompt"))
  .option("-s, --start <time>", field("media_listen", "start"))
  .option("-e, --end <time>", field("media_listen", "end"))
  .action((ref: string, opts: Omit<ToolInput<"media_listen">, "path">) => run("media_listen", { path: assetPath(ref), ...opts }));
const assets = program
  .command("assets")
  .alias("a")
  .description(
    "Search the internet for importable media and import files into the open project's asset library. Search needs no open project; import needs one.",
  );

assets
  .command("search")
  .description(describe("assets_search"))
  .argument("<query>", field("assets_search", "query"))
  .option("--providers <ids...>", field("assets_search", "providers"))
  .option("-k, --kinds <kinds...>", field("assets_search", "kinds"))
  .option("--orientation <o>", field("assets_search", "orientation"))
  .option("--license <l>", field("assets_search", "license"))
  .option("--no-safe", field("assets_search", "safe"))
  .option("--page <n>", field("assets_search", "page"), numeric)
  .option("-n, --per-page <n>", field("assets_search", "perPage"), numeric)
  .action((query: string, opts: Omit<ToolInput<"assets_search">, "query">) => run("assets_search", { query, ...opts }));

assets
  .command("import")
  .description(`${describe("assets_import")} The candidate JSON may be prefixed with @ to read it from a file.`)
  .option("-c, --candidate <json>", field("assets_import", "candidate"))
  .option("-u, --url <url>", field("assets_import", "url"))
  .option("--alternate <label>", field("assets_import", "alternate"))
  .option("--query <q>", field("assets_import", "query"))
  .option("--name <name>", field("assets_import", "name"))
  .option("--folder <folder>", field("assets_import", "folder"))
  .action(
    (opts: { candidate?: string; url?: string; alternate?: string; query?: string; name?: string; folder?: string }) => {
      let candidate: ToolInput<"assets_import">["candidate"];
      if (opts.candidate !== undefined) {
        const raw = opts.candidate.startsWith("@") ? readFileSync(opts.candidate.slice(1), "utf8") : opts.candidate;
        try {
          candidate = JSON.parse(raw);
        } catch {
          return failSync("Could not parse --candidate as JSON.");
        }
      }
      const { candidate: _raw, ...rest } = opts;
      return run("assets_import", { ...rest, candidate });
    },
  );


program
  .command("models")
  .description(describe("models"))
  .argument("[type]", field("models", "type"))
  .action((type: ToolInput<"models">["type"]) => run("models", { type }));

program
  .command("voices")
  .description(describe("voices"))
  .action(() => run("voices", {}));

program
  .command("whoami")
  .description(describe("whoami"))
  .action(() => run("whoami", {}));

program
  .command("logs")
  .description(describe("logs"))
  .option("-n, --tail <n>", field("logs", "tail"), numeric)
  .option("-l, --level <level>", field("logs", "level"))
  .option("--since <ms>", field("logs", "since"), numeric)
  .option("-c, --contains <text>", field("logs", "contains"))
  .action((opts: ToolInput<"logs">) => run("logs", opts));

program
  .command("screenshot")
  .description(describe("screenshot"))
  .option("-o, --output <dir>", field("screenshot", "output"))
  .action((opts: ToolInput<"screenshot">) => run("screenshot", { output: opts.output && resolve(opts.output) }));

program
  .command("report")
  .alias("issue")
  .description(describe("report"))
  .argument("<title>", field("report", "title"))
  .option("-b, --body <text>", field("report", "body"))
  .option("-c, --commands <cmd...>", field("report", "commands"))
  .option("--logs <n>", field("report", "logs"), numeric)
  .action((title: string, opts: Omit<ToolInput<"report">, "title">) => run("report", { title, ...opts }));

program
  .command("fonts")
  .description(describe("fonts"))
  .option("-f, --family <pattern>", field("fonts", "family"))
  .option("-w, --weights <weights...>", field("fonts", "weights"))
  .option("-s, --style <style>", field("fonts", "style"))
  .option("-l, --limit <n>", field("fonts", "limit"), numeric)
  .action((opts: ToolInput<"fonts">) => run("fonts", opts));

// Explicit argv convention: the packaged wrapper runs this bundle on
// Electron in ELECTRON_RUN_AS_NODE mode, where commander would otherwise
// detect Electron and drop the script path from argv.
program.parse(process.argv, { from: "node" });
