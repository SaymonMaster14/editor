/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshMcp(): Promise<typeof import("./mcp")> {
  vi.resetModules();
  return import("./mcp");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("MCP endpoint", () => {
  it("defaults to the fixed loopback port", async () => {
    const mcp = await freshMcp();
    expect(mcp.MCP_HOST).toBe("127.0.0.1");
    expect(mcp.MCP_PORT).toBe(3274);
    expect(mcp.MCP_URL).toBe("http://127.0.0.1:3274/mcp");
  });

  it("moves off the default under DIFFUSION_MCP_PORT", async () => {
    vi.stubEnv("DIFFUSION_MCP_PORT", "4321");
    const mcp = await freshMcp();
    expect(mcp.MCP_PORT).toBe(4321);
    expect(mcp.MCP_URL).toBe("http://127.0.0.1:4321/mcp");
  });

  it("ignores a blank override", async () => {
    vi.stubEnv("DIFFUSION_MCP_PORT", "  ");
    expect((await freshMcp()).MCP_PORT).toBe(3274);
  });

  it("rejects a non-port override", async () => {
    for (const bad of ["dapi", "0", "65536", "3.5"]) {
      vi.stubEnv("DIFFUSION_MCP_PORT", bad);
      await expect(freshMcp()).rejects.toThrow(/DIFFUSION_MCP_PORT/);
    }
  });
});
