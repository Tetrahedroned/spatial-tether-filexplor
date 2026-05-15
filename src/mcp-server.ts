#!/usr/bin/env node
// ---------------------------------------------------------------------------
// spatial-tether-filexplor — MCP server (Phase 5)
//
// Stdio-transport MCP server that wraps `SpatialTetherFileExplorer` and a
// `Session`. Every gateway and session method is exposed as an MCP tool so
// any MCP-compatible client can drive the file explorer the same way the
// in-process API does.
//
// A session is auto-started at server boot. `start_session` resets it.
// ---------------------------------------------------------------------------
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";

import { SpatialTetherFileExplorer } from "./gateway";
import { Session } from "./session";
import { SymbolKind } from "./fs-manifest";

// ---------------------------------------------------------------------------
// Boot — resolve the project root, scan, start the auto-session.
// ---------------------------------------------------------------------------
const projectRoot = path.resolve(process.argv[2] ?? process.cwd());

const explorer = new SpatialTetherFileExplorer(projectRoot);
explorer.scan();
let session: Session = explorer.startSession();

// Helper: wrap any value as an MCP `text` content block (always JSON).
function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

// Helper: wrap a plain string (e.g. roomToText output) as MCP text content.
function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// Helper: ensure the active session reference matches the gateway's session.
// `start_session` swaps the gateway's session out from under us, so we need
// to rebind for the next session-aware tool call.
function activeSession(): Session {
  const current = explorer.currentSession();
  if (current && current !== session) session = current;
  return session;
}

const SYMBOL_KINDS: SymbolKind[] = [
  "function", "class", "method", "const", "var", "type", "interface", "enum",
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "spatial-tether-filexplor",
  version: "0.1.0",
});

// ── FSM / project queries ──────────────────────────────────────────────────

server.registerTool("scan", {
  description: "Re-scan the project and rebuild the FSM. Returns the project summary.",
  inputSchema: {},
}, async () => {
  explorer.scan();
  return textResult(explorer.summarize());
});

server.registerTool("summarize", {
  description: "Get a project overview: language profile, entry points, top-gravity files.",
  inputSchema: {},
}, async () => textResult(explorer.summarize()));

server.registerTool("refresh", {
  description:
    "Incremental refresh: re-scan the project, reuse atoms whose source mtime " +
    "is unchanged, and return a diff of added/updated/removed atom IDs.",
  inputSchema: {},
}, async () => jsonResult(explorer.refresh()));

server.registerTool("full_scan", {
  description: "Force a full re-scan, bypassing incremental shortcuts. Returns the project summary.",
  inputSchema: {},
}, async () => {
  explorer.fullScan();
  return textResult(explorer.summarize());
});

// ── Atom queries ───────────────────────────────────────────────────────────

server.registerTool("get_atom", {
  description: "Resolve a file/dir path to its FSM atom.",
  inputSchema: {
    path: z.string().describe("Project-relative or absolute path."),
  },
}, async ({ path: p }) => jsonResult(explorer.getAtom(p)));

server.registerTool("find_file", {
  description:
    "Find files by name pattern (substring match by default; supports `*` glob). " +
    "Returns gravity-sorted file atoms.",
  inputSchema: {
    pattern: z.string().describe("Substring or glob pattern."),
    limit: z.number().int().positive().optional().describe("Max results (default 50)."),
  },
}, async ({ pattern, limit }) => jsonResult(explorer.findFile(pattern, limit)));

server.registerTool("find_symbol", {
  description:
    "Find symbols (functions, classes, methods, types, interfaces, enums, consts) " +
    "by name. Optional `kind` filter narrows results.",
  inputSchema: {
    pattern: z.string().describe("Symbol name substring or glob."),
    kind: z.enum(SYMBOL_KINDS as [SymbolKind, ...SymbolKind[]]).optional(),
    limit: z.number().int().positive().optional(),
  },
}, async ({ pattern, kind, limit }) =>
  jsonResult(explorer.findSymbol(pattern, { kind, limit })),
);

server.registerTool("get_symbol", {
  description:
    "Look up a single symbol by atom ID or qualified rel_path " +
    "(e.g. \"src/auth.ts#verifyToken\").",
  inputSchema: {
    id_or_rel_path: z.string(),
  },
}, async ({ id_or_rel_path }) => jsonResult(explorer.getSymbol(id_or_rel_path)));

server.registerTool("find_callers", {
  description:
    "Return symbol atoms that reference (call/use) the target symbol. " +
    "Identify the target by atom ID or qualified rel_path " +
    "(e.g. \"src/fs-engine.ts#buildFSM\"). Result is gravity-sorted.",
  inputSchema: {
    id_or_rel_path: z.string(),
  },
}, async ({ id_or_rel_path }) => jsonResult(explorer.findCallers(id_or_rel_path)));

server.registerTool("find_callees", {
  description:
    "Return symbol atoms that the target symbol references (calls/uses). " +
    "Identify the target by atom ID or qualified rel_path. " +
    "Result is gravity-sorted.",
  inputSchema: {
    id_or_rel_path: z.string(),
  },
}, async ({ id_or_rel_path }) => jsonResult(explorer.findCallees(id_or_rel_path)));

server.registerTool("get_relationship", {
  description:
    "Compute the structural relationship between two atoms (files or symbols) " +
    "without materializing two full Rooms. Returns a_imports_b / b_imports_a " +
    "booleans, the list of shared importers (files that import BOTH), and " +
    "call-graph edges aggregated across each side's symbols (a_calls_b, " +
    "b_calls_a). O(symbols-per-file + shared-importers); avoids the O(N) " +
    "cost of two getRoom calls when the question is just 'how are these " +
    "related?'.",
  inputSchema: {
    id_a: z.string(),
    id_b: z.string(),
  },
}, async ({ id_a, id_b }) => jsonResult(explorer.getRelationship(id_a, id_b)));

// ── Room construction ──────────────────────────────────────────────────────

server.registerTool("get_room", {
  description:
    "Get a Room JSON for the given focus path. Routes through the active " +
    "session so navigation history is updated and gravity reflects session signals.",
  inputSchema: {
    focus_path: z.string(),
    depth_limit: z.number().int().min(0).optional(),
  },
}, async ({ focus_path, depth_limit }) =>
  jsonResult(explorer.getRoom(focus_path, depth_limit ?? 2)),
);

server.registerTool("describe_room", {
  description: "Get the rendered text Room description (what the agent reads).",
  inputSchema: {
    focus_path: z.string(),
    depth_limit: z.number().int().min(0).optional(),
  },
}, async ({ focus_path, depth_limit }) =>
  textResult(explorer.describeRoom(focus_path, depth_limit ?? 2)),
);

// ── Session lifecycle ──────────────────────────────────────────────────────

server.registerTool("start_session", {
  description:
    "Reset the session. Returns a snapshot of the new (empty) session.",
  inputSchema: {},
}, async () => {
  session = explorer.startSession();
  return jsonResult(session.serialize());
});

server.registerTool("end_session", {
  description:
    "Detach the current session and return its final snapshot. " +
    "Subsequent session-aware calls will fail until a new session is started.",
  inputSchema: {},
}, async () => jsonResult(explorer.endSession()));

server.registerTool("current_session", {
  description: "Return the current session's snapshot, or null if no session is attached.",
  inputSchema: {},
}, async () => {
  const s = explorer.currentSession();
  return jsonResult(s ? s.serialize() : null);
});

// ── Session navigation + Investigation Check ───────────────────────────────

server.registerTool("enter_room", {
  description:
    "Enter a Room — pushes the visit to the session's history and returns the " +
    "Room JSON. The session must be active.",
  inputSchema: {
    focus_path: z.string(),
    depth_limit: z.number().int().min(0).optional(),
  },
}, async ({ focus_path, depth_limit }) => {
  const s = activeSession();
  return jsonResult(s.enterRoom(focus_path, depth_limit));
});

server.registerTool("request_file", {
  description:
    "Investigation Check: request a file outside the current Room. " +
    "If the file is in the Room or inventory, granted for free. Otherwise a " +
    "non-empty `justification` is required. Every call is logged.",
  inputSchema: {
    rel_path: z.string(),
    justification: z.string().optional(),
  },
}, async ({ rel_path, justification }) => {
  const s = activeSession();
  return jsonResult(s.requestFile(rel_path, justification));
});

server.registerTool("get_inventory", {
  description: "List atoms the agent has explicitly pulled into its inventory this session.",
  inputSchema: {},
}, async () => {
  const s = activeSession();
  return jsonResult(s.getInventory());
});

server.registerTool("get_history", {
  description: "Ordered navigation log of Rooms entered this session.",
  inputSchema: {},
}, async () => {
  const s = activeSession();
  return jsonResult(s.getHistory());
});

// ── Persistence — Phase 4 ──────────────────────────────────────────────────

server.registerTool("save_fsm", {
  description:
    "Persist the current FSM to JSON. Defaults to <projectRoot>/.spatial-tether/fsm.json " +
    "when `path` is omitted.",
  inputSchema: {
    path: z.string().optional().describe("Override the cache file path."),
  },
}, async ({ path: p }) => jsonResult(await explorer.save(p)));

server.registerTool("load_fsm", {
  description:
    "Load the FSM from JSON. Falls back to a full scan on version mismatch, " +
    "missing file, or parse error.",
  inputSchema: {
    path: z.string().optional(),
  },
}, async ({ path: p }) => jsonResult(await explorer.load(p)));

server.registerTool("save_session", {
  description: "Persist the active session snapshot to JSON.",
  inputSchema: {
    path: z.string().optional(),
  },
}, async ({ path: p }) => jsonResult(await explorer.saveSession(p)));

server.registerTool("load_session", {
  description: "Restore a session snapshot from JSON. Replaces any active session.",
  inputSchema: {
    path: z.string().optional(),
  },
}, async ({ path: p }) => jsonResult(await explorer.loadSession(p)));

// ── File watcher — Phase 4 ─────────────────────────────────────────────────

server.registerTool("watch", {
  description:
    "Start watching the project root. File changes trigger an incremental " +
    "refresh and emit `update` events on the gateway's internal EventEmitter " +
    "(consumed by the Phase 6 HTTP/WS server).",
  inputSchema: {},
}, async () => {
  explorer.watch();
  return jsonResult({ watching: true });
});

server.registerTool("unwatch", {
  description: "Stop the chokidar watcher.",
  inputSchema: {},
}, async () => {
  await explorer.unwatch();
  return jsonResult({ watching: false });
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Emit a ready signal on stderr so launchers can see the server is up.
  // stdout is reserved for MCP JSON-RPC framing; never write to it directly.
  process.stderr.write(
    `[spatial-tether-filexplor] MCP server ready on stdio (project: ${projectRoot})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[spatial-tether-filexplor] fatal: ${String(err)}\n`);
  process.exit(1);
});
