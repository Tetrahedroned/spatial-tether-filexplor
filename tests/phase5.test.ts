import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_BIN   = path.join(PROJECT_ROOT, "dist", "mcp-server.js");
const FIXTURE      = path.join(PROJECT_ROOT, "fixtures", "ts-app");

// Parse the JSON inside an MCP CallToolResult's first text content block.
function parseToolJSON(result: any): any {
  expect(result).toBeDefined();
  expect(result.content).toBeInstanceOf(Array);
  expect(result.content.length).toBeGreaterThan(0);
  const block = result.content[0];
  expect(block.type).toBe("text");
  return JSON.parse(block.text);
}

function getToolText(result: any): string {
  expect(result.content?.[0]?.type).toBe("text");
  return result.content[0].text as string;
}

describe("Phase 5: MCP server (stdio)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!fs.existsSync(SERVER_BIN)) {
      throw new Error(
        `MCP server binary not built. Run \`npm run build\` first. Expected at: ${SERVER_BIN}`,
      );
    }

    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_BIN, FIXTURE],
    });
    client = new Client({ name: "phase5-test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Initialize + tool inventory
  // ────────────────────────────────────────────────────────────────────────

  it("initialize handshake succeeded (client connected)", () => {
    const sv = client.getServerVersion();
    expect(sv).toBeDefined();
    expect(sv?.name).toBe("spatial-tether-filexplor");
  });

  it("tools/list returns at least 14 tools and includes the expected names", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(14);

    const names = new Set(tools.map((t) => t.name));
    for (const expected of [
      "scan", "summarize", "refresh",
      "get_atom", "find_file", "find_symbol", "get_symbol",
      "get_room", "describe_room",
      "start_session", "end_session", "current_session",
      "enter_room", "request_file", "get_inventory", "get_history",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Read-only queries
  // ────────────────────────────────────────────────────────────────────────

  it("scan returns a project summary", async () => {
    const result = await client.callTool({ name: "scan", arguments: {} });
    const text = getToolText(result);
    expect(text).toMatch(/PROJECT: ts-app/);
  });

  it("find_file returns auth-related atoms from fixture", async () => {
    const result = await client.callTool({
      name: "find_file",
      arguments: { pattern: "auth" },
    });
    const atoms = parseToolJSON(result);
    expect(Array.isArray(atoms)).toBe(true);
    expect(atoms.length).toBeGreaterThan(0);
    const relPaths = atoms.map((a: any) => a.rel_path);
    expect(relPaths).toContain("src/auth.ts");
  });

  it("get_room returns valid Room JSON for src/auth.ts", async () => {
    const result = await client.callTool({
      name: "get_room",
      arguments: { focus_path: "src/auth.ts" },
    });
    const room = parseToolJSON(result);
    expect(room.focus_path).toBe("src/auth.ts");
    expect(room.atoms).toBeInstanceOf(Array);
    expect(room.atoms.length).toBeGreaterThan(0);
    expect(room.inclusion).toBeDefined();
  });

  it("find_symbol returns verifyToken with kind filter", async () => {
    const result = await client.callTool({
      name: "find_symbol",
      arguments: { pattern: "verify", kind: "function" },
    });
    const symbols = parseToolJSON(result);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.map((s: any) => s.name)).toContain("verifyToken");
  });

  // ────────────────────────────────────────────────────────────────────────
  // Investigation Check round-trip over MCP
  // ────────────────────────────────────────────────────────────────────────

  it("Investigation Check: out-of-room without justification → denied", async () => {
    // Auto-session is already active from server boot. Reset cleanly.
    await client.callTool({ name: "start_session", arguments: {} });

    // Enter src/auth.ts at depth_limit=0 so README.md (depth 1) is genuinely
    // out of room.
    await client.callTool({
      name: "enter_room",
      arguments: { focus_path: "src/auth.ts", depth_limit: 0 },
    });

    const result = await client.callTool({
      name: "request_file",
      arguments: { rel_path: "README.md" },
    });
    const investigation = parseToolJSON(result);
    expect(investigation.granted).toBe(false);
    expect(investigation.outcome).toBe("denied");
  });

  it("Investigation Check: with justification → investigation_passed", async () => {
    const granted = await client.callTool({
      name: "request_file",
      arguments: {
        rel_path: "README.md",
        justification: "checking project README for context",
      },
    });
    const investigation = parseToolJSON(granted);
    expect(investigation.granted).toBe(true);
    expect(investigation.outcome).toBe("investigation_passed");

    // Inventory should now include README.md
    const invResult = await client.callTool({ name: "get_inventory", arguments: {} });
    const inventory = parseToolJSON(invResult);
    const relPaths = inventory.map((a: any) => a.rel_path);
    expect(relPaths).toContain("README.md");
  });

  it("get_history reflects the entered Rooms", async () => {
    const result = await client.callTool({ name: "get_history", arguments: {} });
    const history = parseToolJSON(result);
    expect(history.length).toBeGreaterThan(0);
    expect(history.map((v: any) => v.focus_path)).toContain("src/auth.ts");
  });

  it("end_session returns a snapshot with the investigation log", async () => {
    const result = await client.callTool({ name: "end_session", arguments: {} });
    const snap = parseToolJSON(result);
    expect(snap.investigation_log.length).toBeGreaterThanOrEqual(2);
    const outcomes = snap.investigation_log.map((e: any) => e.outcome);
    expect(outcomes).toContain("denied");
    expect(outcomes).toContain("investigation_passed");
  });
});
