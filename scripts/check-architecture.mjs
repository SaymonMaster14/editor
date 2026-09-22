// Architecture constitution, executable. Usage:
//   node scripts/check-architecture.mjs [--root <dir>]
// Scans apps/* and packages/* and fails on:
//   app-inversion  packages/* importing apps/* (layers flow down only)
//   phantom-dep    @diffusionstudio/* imports a workspace never declared
//   ws-cycle       dependency cycles between workspaces
//   module-cycle   relative-import value cycles within a workspace
//   size           executable files over 1000 lines without an exception
//   part-name      part2/splitN filenames (decompose the responsibility)
//   handler-layer  DAPI renderer handlers importing harness code
// Warns (review, non-failing) on 600-1000 line files, hot complexity,
// and wide fan-out. Legitimate giants live in architecture-exceptions.json
// with a reason; stale exceptions fail too, so the file cannot rot.
// Dependency-free by design: no toolchain to count lines.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const ROOT = process.argv.includes("--root")
  ? normalize(process.argv[process.argv.indexOf("--root") + 1] ?? ".")
  : normalize(join(import.meta.dirname, ".."));
const rel = (p) => normalize(p).replace(/\\/g, "/");
const ROOT_FWD = rel(ROOT).replace(/\/$/, "");

const SIZE_ERROR = 1000;
const SIZE_WARN = 600;
const BRANCH_WARN = 150;
const BRANCH_LINES = 600;
const FANOUT_WARN = 25;

const errors = [];
const warnings = [];
const fail = (rule, files, detail) => errors.push({ rule, files, detail });
const warn = (rule, files, detail) => warnings.push({ rule, files, detail });

// --- file inventory ----------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "tmp", ".turbo", "coverage"]);
const SOURCES = new Map(); // rel path -> content
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!/\.(m|c)?(t|j)sx?$/.test(entry.name)) continue;
    const relPath = rel(full).slice(ROOT_FWD.length + 1);
    if (!/^(apps|packages)\//.test(relPath)) continue;
    SOURCES.set(relPath, readFileSync(full, "utf8"));
  }
}
walk(ROOT);

const isTest = (p) => /\.test\.[mc]?[tj]sx?$/.test(p) || /\/fixtures\//.test(p) || /\/__tests__\//.test(p);
const isDecl = (p) => p.endsWith(".d.ts");
const isGenerated = (p) => /\/generated\//.test(p);
const isBarrel = (p) => /(^|\/)(index|catalog)\.[mc]?[tj]sx?$/.test(p);
const isExecutable = (p) => /\.[mc]?tsx?$/.test(p) && !isTest(p) && !isDecl(p) && !isGenerated(p);

// --- workspaces ---------------------------------------------------------------
const WORKSPACES = new Map(); // dir -> { name, declared:Set, local:Set }
for (const scope of ["apps", "packages"]) {
  const scopeDir = join(ROOT, scope);
  if (!existsSync(scopeDir)) continue;
  for (const name of readdirSync(scopeDir)) {
    const pkgFile = join(scopeDir, name, "package.json");
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    const declared = new Set(
      Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies })
        .filter((d) => d.startsWith("@diffusionstudio/")),
    );
    WORKSPACES.set(`${scope}/${name}`, { name: pkg.name, declared });
  }
}
const NAME_TO_DIR = new Map([...WORKSPACES.entries()].map(([dir, ws]) => [ws.name, dir]));
const wsOf = (relPath) => {
  const m = relPath.match(/^(apps|packages)\/[^/]+/);
  return m ? m[0] : null;
};

// --- comment-stripped import scan ----------------------------------------------
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (ch === "\n") { lineComment = false; out += ch; }
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i += 2; continue; }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") { lineComment = true; i += 2; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i += 2; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

function fileImports(content) {
  const clean = stripComments(content);
  const found = [];
  for (const m of clean.matchAll(/^\s*import\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    found.push({ spec: m[2], typeOnly: !!m[1], dynamic: false });
  }
  for (const m of clean.matchAll(/^\s*export\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s+['"]([^'"]+)['"]/gm)) {
    found.push({ spec: m[2], typeOnly: !!m[1], dynamic: false });
  }
  for (const m of clean.matchAll(/(?:import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
    found.push({ spec: m[1], typeOnly: false, dynamic: true });
  }
  return found;
}

const IMPORTS = new Map(); // rel path -> [{ spec, typeOnly }]
for (const [path, content] of SOURCES) IMPORTS.set(path, fileImports(content));

function resolveRelative(from, spec) {
  const base = normalize(join(ROOT, dirname(from), spec)).replace(/\\/g, "/");
  const cands = [base];
  const noJs = base.replace(/\.js$/, "");
  if (noJs !== base) cands.push(noJs);
  const out = [];
  for (const c of cands) {
    out.push(c, `${c}.ts`, `${c}.tsx`, `${c}.mts`, `${c}.cts`, `${c}/index.ts`, `${c}/index.tsx`);
  }
  for (const c of out) {
    const r = c.startsWith(`${ROOT_FWD}/`) ? c.slice(ROOT_FWD.length + 1) : null;
    if (r && SOURCES.has(r)) return r;
  }
  return null;
}

// --- exceptions ----------------------------------------------------------------
const EXC_FILE = join(ROOT, "architecture-exceptions.json");
let exceptions = [];
if (existsSync(EXC_FILE)) {
  const parsed = JSON.parse(readFileSync(EXC_FILE, "utf8"));
  if (!Array.isArray(parsed)) {
    console.error("architecture-exceptions.json must be an array");
    process.exit(2);
  }
  exceptions = parsed;
}
const KNOWN_RULES = new Set(["app-inversion", "phantom-dep", "ws-cycle", "module-cycle", "size", "part-name", "handler-layer"]);
const usedExceptions = new Set();
for (const [i, e] of exceptions.entries()) {
  if (!e || !Array.isArray(e.files) || e.files.length === 0 || typeof e.rule !== "string" || typeof e.reason !== "string" || !e.reason.trim()) {
    fail("exception-shape", [`architecture-exceptions.json[${i}]`], "entries need non-empty files[], rule, and reason");
    continue;
  }
  if (!KNOWN_RULES.has(e.rule)) fail("exception-shape", [`architecture-exceptions.json[${i}]`], `unknown rule "${e.rule}"`);
  for (const f of e.files) {
    if (!SOURCES.has(f) && !existsSync(join(ROOT, f))) fail("exception-shape", [f], "excepted file does not exist");
  }
}
function excused(rule, files) {
  const key = [...files].sort().join("\n");
  const idx = exceptions.findIndex((e) => e.rule === rule && [...e.files].sort().join("\n") === key);
  if (idx === -1) return false;
  usedExceptions.add(idx);
  return true;
}

// --- R1/R2/R9: layers and declarations ------------------------------------------
for (const [path, imports] of IMPORTS) {
  const ws = wsOf(path);
  const info = ws ? WORKSPACES.get(ws) : null;
  for (const { spec } of imports) {
    if (spec.startsWith("@diffusionstudio/")) {
      // Subpath imports ("@diffusionstudio/assets/internet") resolve against
      // the declared package name, not the full specifier.
      const pkgName = spec.split("/").slice(0, 2).join("/");
      const target = NAME_TO_DIR.get(pkgName);
      if (ws && ws.startsWith("packages/") && target && target.startsWith("apps/")) {
        if (!excused("app-inversion", [path])) fail("app-inversion", [path], `package file imports app workspace ${spec}`);
      }
      if (info && !info.declared.has(pkgName)) {
        if (!excused("phantom-dep", [path])) fail("phantom-dep", [path], `${spec} is imported but not declared in ${ws}/package.json`);
      }
    } else if (spec.startsWith(".")) {
      const target = normalize(join(ROOT, dirname(path), spec)).replace(/\\/g, "/");
      const targetRel = target.startsWith(`${ROOT_FWD}/`) ? target.slice(ROOT_FWD.length + 1) : target;
      if (ws && ws.startsWith("packages/") && /^(apps\/|\.\.)/.test(targetRel) && targetRel.startsWith("apps/")) {
        if (!excused("app-inversion", [path])) fail("app-inversion", [path], `package file reaches into apps/ via "${spec}"`);
      }
    }
    if (path.startsWith("apps/web/src/dapi/handlers/") && spec.includes("agent-chat")) {
      if (!excused("handler-layer", [path])) fail("handler-layer", [path], "DAPI handlers serve agents; they must not import harness code");
    }
  }
}

// --- R3: workspace cycles ---------------------------------------------------------
function tarjan(nodes, edges) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let counter = 0;
  function visit(node) {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges(node)) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== node);
      if (comp.length > 1) cycles.push(comp.sort());
      else if (edges(node).includes(node)) cycles.push(comp);
    }
  }
  for (const node of nodes) if (!index.has(node)) visit(node);
  return cycles;
}

{
  const dirs = [...WORKSPACES.keys()];
  const cycles = tarjan(dirs, (dir) => {
    const pkgFile = join(ROOT, dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
      .filter((d) => d.startsWith("@diffusionstudio/") && NAME_TO_DIR.has(d))
      .map((d) => NAME_TO_DIR.get(d));
  });
  for (const cycle of cycles) {
    if (!excused("ws-cycle", cycle)) fail("ws-cycle", cycle, `dependency cycle: ${cycle.join(" -> ")}`);
  }
}

// --- R4: module cycles --------------------------------------------------------------
{
  const nodes = [...SOURCES.keys()].filter((p) => !isTest(p) && !isDecl(p));
  const nodeSet = new Set(nodes);
  const edges = (path) => {
    const out = [];
    for (const { spec, typeOnly } of IMPORTS.get(path) ?? []) {
      if (typeOnly || !spec.startsWith(".")) continue;
      const target = resolveRelative(path, spec);
      if (target && nodeSet.has(target) && wsOf(target) === wsOf(path)) out.push(target);
    }
    return out;
  };
  for (const cycle of tarjan(nodes, edges)) {
    if (!excused("module-cycle", cycle)) {
      fail("module-cycle", cycle, `import cycle within ${wsOf(cycle[0])}: ${cycle.map((f) => f.split("/").slice(-1)[0]).join(" -> ")}`);
    }
  }
}

// --- R5/R6/R7: size, complexity, fan-out ----------------------------------------------
const BRANCH_RE = /\b(if|for|while|catch|case)\b|&&|\?\?/g;
for (const [path, content] of SOURCES) {
  if (!isExecutable(path)) continue;
  const lines = content.split("\n").length;
  if (lines > SIZE_ERROR) {
    if (!excused("size", [path])) fail("size", [path], `${lines} lines exceeds ${SIZE_ERROR} — split the responsibility or record an exception`);
  } else if (lines > SIZE_WARN) {
    warn("size", [path], `${lines} lines is past the ${SIZE_WARN}-line review threshold`);
  }
  if (lines > BRANCH_LINES) {
    const branches = (stripComments(content).match(BRANCH_RE) || []).length;
    if (branches > BRANCH_WARN) warn("complexity", [path], `~${branches} branches over ${lines} lines — review for decomposition`);
  }
  if (!isBarrel(path)) {
    const fanout = (IMPORTS.get(path) ?? []).length;
    if (fanout > FANOUT_WARN) warn("fanout", [path], `${fanout} imports — review for god-module assembly`);
  }
  const base = path.split("/").slice(-1)[0] ?? "";
  if (/part\d|_part\d|split\d|_split\d/i.test(base)) {
    if (!excused("part-name", [path])) fail("part-name", [path], "split the responsibility into owned modules, not the file into numbered parts");
  }
}

// --- stale exceptions ---------------------------------------------------------------
exceptions.forEach((e, i) => {
  if (!usedExceptions.has(i) && KNOWN_RULES.has(e.rule)) {
    fail("stale-exception", e.files, `exception for "${e.rule}" silenced nothing — remove it`);
  }
});

// --- report ----------------------------------------------------------------------------
for (const e of errors) console.log(`ERROR ${e.rule} ${e.files.join(", ")}\n      ${e.detail}`);
for (const w of warnings) console.log(`WARN  ${w.rule} ${w.files.join(", ")}\n      ${w.detail}`);
console.log(`${errors.length === 0 ? "PASS" : "FAIL"}: ${errors.length} error(s), ${warnings.length} warning(s), ${SOURCES.size} files, ${usedExceptions.size}/${exceptions.length} exceptions applied`);
process.exit(errors.length === 0 ? 0 : 1);
