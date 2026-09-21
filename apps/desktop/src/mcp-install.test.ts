/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_URL } from "@diffusionstudio/dapi";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyMcp, healMcpRegistrations, mcpStatus } from "./mcp-install";

import type { McpInstallEnv } from "./mcp-install";

// The tests always pass an explicit env pointing at a fixture home, so the
// Electron app object is never consulted; if one ever forgets, fail loudly
// instead of reading or writing the real machine.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => {
      throw new Error("test must pass McpInstallEnv");
    },
  },
}));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-install-"));
  tempDirs.push(dir);
  return dir;
}

type WindowsFixture = { e: McpInstallEnv; homeDir: string; appdata: string; exe: string; bundle: string };

/** A packaged Windows install over a fixture home: stub exe plus one versioned bundle. */
function packagedWindows(root: string): WindowsFixture {
  const homeDir = join(root, "home");
  const appdata = join(homeDir, "AppData", "Roaming");
  const installRoot = join(root, "DiffusionStudio");
  const exe = join(installRoot, "Diffusion Studio.exe");
  const bundle = join(installRoot, "app-0.205.2", "resources", "cli", "dapi.js");
  mkdirSync(appdata, { recursive: true });
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(exe, "");
  writeFileSync(bundle, "");
  const e: McpInstallEnv = {
    homeDir,
    platform: "win32",
    env: { APPDATA: appdata },
    isPackaged: true,
    resourcesPath: join(installRoot, "app-0.205.2", "resources"),
    appPath: join(installRoot, "app-0.205.2", "resources", "app.asar"),
  };
  return { e, homeDir, appdata, exe, bundle };
}

/** A packaged macOS install over a fixture home, for the preserved-bundle-path behavior. */
function packagedMac(root: string): { e: McpInstallEnv; homeDir: string; binary: string } {
  const homeDir = join(root, "home");
  const binary = join(root, "Diffusion Studio.app", "Contents", "Resources", "cli", "bin", "dapi");
  mkdirSync(join(homeDir, "Library", "Application Support"), { recursive: true });
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "");
  const e: McpInstallEnv = {
    homeDir,
    platform: "darwin",
    env: {},
    isPackaged: true,
    resourcesPath: join(root, "Diffusion Studio.app", "Contents", "Resources"),
    appPath: join(root, "Diffusion Studio.app", "Contents", "Resources", "app.asar"),
  };
  return { e, homeDir, binary };
}

function statusFor(e: McpInstallEnv, id: "codex" | "cursor" | "vscode" | "claude-desktop") {
  const found = mcpStatus(e).agents.find((agent) => agent.id === id);
  if (!found) throw new Error(`no status for ${id}`);
  return found;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("status", () => {
  test("a bare fixture home reports every agent undetected and unconnected", () => {
    const { e } = packagedWindows(tempDir());
    const status = mcpStatus(e);
    expect(status.url).toBe(MCP_URL);
    expect(status.agents).toHaveLength(8);
    for (const agent of status.agents) {
      expect(agent.detected).toBe(false);
      expect(agent.connected).toBe(false);
      expect(agent.unavailable).toBeNull();
    }
  });

  test("markers detect installed agents and configs resolve under the fixture home", () => {
    const { e, homeDir, appdata } = packagedWindows(tempDir());
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(appdata, "Code"), { recursive: true });
    mkdirSync(join(appdata, "Claude"), { recursive: true });

    expect(statusFor(e, "codex").detected).toBe(true);
    expect(statusFor(e, "codex").config).toBe(join(homeDir, ".codex", "config.toml"));
    expect(statusFor(e, "cursor").detected).toBe(false);
    expect(statusFor(e, "vscode").detected).toBe(true);
    expect(statusFor(e, "vscode").config).toBe(join(appdata, "Code", "User", "mcp.json"));
    expect(statusFor(e, "claude-desktop").detected).toBe(true);
    expect(statusFor(e, "claude-desktop").config).toBe(join(appdata, "Claude", "claude_desktop_config.json"));
  });
});

describe("connect and disconnect", () => {
  test("connect writes only our entry; other servers and keys survive (JSON and TOML)", () => {
    const { e, homeDir } = packagedWindows(tempDir());
    const cursorConfig = join(homeDir, ".cursor", "mcp.json");
    mkdirSync(dirname(cursorConfig), { recursive: true });
    writeFileSync(cursorConfig, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const codexConfig = join(homeDir, ".codex", "config.toml");
    mkdirSync(dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');

    const result = applyMcp({ add: ["cursor", "codex"], remove: [] }, e);
    expect(result).toEqual({ added: ["cursor", "codex"], removed: [], failures: [] });

    const cursor = readJson(cursorConfig).mcpServers as Record<string, unknown>;
    expect(cursor.other).toEqual({ command: "x", args: [] });
    expect(cursor.diffusion).toEqual({ url: MCP_URL });
    const codex = readFileSync(codexConfig, "utf8");
    expect(codex).toContain('model = "o3"');
    expect(codex).toContain("[mcp_servers.other]");
    expect(codex).toContain("[mcp_servers.diffusion]");
    expect(codex).toContain(`url = "${MCP_URL}"`);

    expect(statusFor(e, "cursor").connected).toBe(true);
    expect(statusFor(e, "codex").connected).toBe(true);
  });

  test("disconnect removes only our entry and is a no-op the second time", () => {
    const { e, homeDir } = packagedWindows(tempDir());
    applyMcp({ add: ["cursor", "codex"], remove: [] }, e);

    const first = applyMcp({ add: [], remove: ["cursor", "codex"] }, e);
    expect(first).toEqual({ added: [], removed: ["cursor", "codex"], failures: [] });
    expect(readJson(join(homeDir, ".cursor", "mcp.json"))).toEqual({ mcpServers: {} });
    expect(readFileSync(join(homeDir, ".codex", "config.toml"), "utf8")).toBe("");
    expect(statusFor(e, "cursor").connected).toBe(false);

    const cursorBefore = readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8");
    const second = applyMcp({ add: [], remove: ["cursor", "codex"] }, e);
    expect(second.failures).toEqual([]);
    expect(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8")).toBe(cursorBefore);
  });

  test("connect, disconnect, connect round-trips through the VS Code servers format", () => {
    const { e, appdata } = packagedWindows(tempDir());
    const config = join(appdata, "Code", "User", "mcp.json");
    applyMcp({ add: ["vscode"], remove: [] }, e);
    expect((readJson(config).servers as Record<string, unknown>).diffusion).toEqual({ type: "http", url: MCP_URL });
    applyMcp({ add: [], remove: ["vscode"] }, e);
    expect(readJson(config)).toEqual({ servers: {} });
    applyMcp({ add: ["vscode"], remove: [] }, e);
    expect(statusFor(e, "vscode").connected).toBe(true);
  });

  test("an unreadable config fails that agent without stopping the rest", () => {
    const { e, homeDir } = packagedWindows(tempDir());
    const cursorConfig = join(homeDir, ".cursor", "mcp.json");
    mkdirSync(dirname(cursorConfig), { recursive: true });
    writeFileSync(cursorConfig, "{ not json");

    const result = applyMcp({ add: ["cursor", "codex"], remove: [] }, e);
    expect(result.added).toEqual(["codex"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.id).toBe("cursor");
    expect(result.failures[0]?.error).toContain(cursorConfig);
    // The file we could not parse is left byte-identical, not overwritten.
    expect(readFileSync(cursorConfig, "utf8")).toBe("{ not json");
  });
});

describe("stdio agents", () => {
  test("Claude Desktop gets the Windows stdio target with node-mode env", () => {
    const { e, appdata, exe, bundle } = packagedWindows(tempDir());
    const result = applyMcp({ add: ["claude-desktop"], remove: [] }, e);
    expect(result.failures).toEqual([]);
    const servers = readJson(join(appdata, "Claude", "claude_desktop_config.json")).mcpServers as Record<string, unknown>;
    expect(servers.diffusion).toEqual({ command: exe, args: [bundle, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  test("a build without the proxy says why, while HTTP agents still connect", () => {
    const { e } = packagedWindows(tempDir());
    rmSync(join(e.resourcesPath, "..", "..", "Diffusion Studio.exe"), { force: true });

    expect(statusFor(e, "claude-desktop").unavailable).toContain("dapi");
    const result = applyMcp({ add: ["claude-desktop", "cursor"], remove: [] }, e);
    expect(result.added).toEqual(["cursor"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ id: "claude-desktop", error: expect.stringContaining("dapi") });
  });

  test("the macOS packaged registration still runs the bundle binary without env", () => {
    const { e, binary } = packagedMac(tempDir());
    const result = applyMcp({ add: ["claude-desktop"], remove: [] }, e);
    expect(result.failures).toEqual([]);
    const config = statusFor(e, "claude-desktop").config;
    expect(config).toBe(join(e.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    const servers = readJson(config).mcpServers as Record<string, unknown>;
    expect(servers.diffusion).toEqual({ command: binary, args: ["mcp"] });
  });
});

describe("self-heal", () => {
  test("rewrites a stale versioned entry and leaves hand-written ones alone", () => {
    const { e, appdata, exe, bundle } = packagedWindows(tempDir());
    const config = join(appdata, "Claude", "claude_desktop_config.json");
    mkdirSync(dirname(config), { recursive: true });
    const stale = join(appdata, "..", "Local", "DiffusionStudio", "app-0.1.0", "Diffusion Studio.exe");
    writeFileSync(
      config,
      JSON.stringify({ mcpServers: { diffusion: { command: stale, args: ["mcp"] }, other: { command: "x", args: [] } } }),
    );

    healMcpRegistrations(e);
    const servers = readJson(config).mcpServers as Record<string, unknown>;
    expect(servers.diffusion).toEqual({ command: exe, args: [bundle, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(servers.other).toEqual({ command: "x", args: [] });

    writeFileSync(config, JSON.stringify({ mcpServers: { diffusion: { command: "C:\\tools\\mine.exe", args: [] } } }));
    healMcpRegistrations(e);
    expect(readJson(config)).toEqual({ mcpServers: { diffusion: { command: "C:\\tools\\mine.exe", args: [] } } });
  });

  test("a dev build never heals", () => {
    const { e, appdata } = packagedWindows(tempDir());
    const dev = { ...e, isPackaged: false };
    const config = join(appdata, "Claude", "claude_desktop_config.json");
    mkdirSync(dirname(config), { recursive: true });
    const stale = JSON.stringify({ mcpServers: { diffusion: { command: "C:\\old\\Diffusion Studio\\app.exe", args: ["mcp"] } } });
    writeFileSync(config, stale);
    healMcpRegistrations(dev);
    expect(readFileSync(config, "utf8")).toBe(stale);
  });
});
