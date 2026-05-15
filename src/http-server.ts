#!/usr/bin/env node
// ---------------------------------------------------------------------------
// http-server.ts — Phase 6 transport.
//
// Express + ws server alongside the MCP server. Same gateway, different
// transport. Routes are prefixed `/api/*`; WS at `/ws`.
//
//   GET  /api/fsm           full FSM regrouped by depth (floors)
//   GET  /api/room          Room JSON for a focus path
//   POST /api/enter_room    update session.current_room, return Room
//   POST /api/request_file  Investigation Check (granted/denied)
//   GET  /api/session       current session snapshot
//   GET  /api/atom          one atom by id or rel_path (+ content if file)
//   GET  /api/file          read raw file content (UI editor)
//   POST /api/file          write file content (UI editor)
//   POST /api/agent_focus   external-caller focus signal
//   POST /api/demo_step     internal navigation, NO WS broadcast (UI screensaver)
//   POST /api/reset_session wipe nav history; broadcasts session_reset
//   POST /api/git           local-only git: status/diff/add/commit/log
//   WS   /ws                init / update / room_change / investigation
//
// API + WebSocket only — no static UI assets. The UI is a separate project
// that connects via the same `/api/*` and `/ws` contract.
// ---------------------------------------------------------------------------
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { exec, execFile } from "child_process";
import express, { Request, Response, NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SpatialTetherFileExplorer } from "./gateway";
import { FSM, FSMAtom } from "./fs-manifest";
import { FSMUpdateEvent } from "./watcher";

export interface HttpServerOptions {
  port?: number;
  // Default 127.0.0.1 — the server exposes file read/write and a git
  // commit endpoint, so binding to all interfaces is opt-in only.
  host?: string;
  // Fix 6 — auto-open the browser on start. Default: true; tests pass false.
  openBrowser?: boolean;
}

// Open the URL in the user's default browser. Detects platform; on failure
// the URL is logged to stderr and the server continues.
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32"  ? "start"
            : "xdg-open";
  exec(`${cmd} ${url}`, (err) => {
    if (err) console.log(`[spatial-tether] open manually: ${url}`);
  });
}

interface FloorPayload {
  [depth: number]: FSMAtom[];
}

interface FSMSnapshotPayload {
  floors: FloorPayload;
  edges: {
    imports: [string, string][];
    calls:   [string, string][];
  };
  summary: {
    project_name: string;
    project_root: string;
    total_files: number;
    total_dirs: number;
    captured_at: string;
    language_profile: Record<string, number>;
    floor_count: number;
    symbol_count: number;
  };
}

// Group atoms by their `geom.x` (depth = floor index) and pull edges.
// Symbols and methods are kept on the same floor as their containing file —
// the dungeon renders them as furniture inside the file room, not as separate
// floor-level shapes.
function snapshotFromFSM(fsm: FSM): FSMSnapshotPayload {
  const floors: FloorPayload = {};
  for (const atom of fsm.atoms) {
    if (atom.kind === "symbol" || atom.kind === "method") continue;
    const depth = atom.geom.x;
    (floors[depth] ??= []).push(atom);
  }

  const importEdges: [string, string][] = [];
  for (const a of fsm.atoms) {
    if (a.kind !== "file") continue;
    for (const target of a.import_refs) importEdges.push([a.id, target]);
  }

  const callEdges: [string, string][] = [];
  for (const a of fsm.atoms) {
    if (a.kind !== "symbol" && a.kind !== "method") continue;
    for (const target of a.references) callEdges.push([a.id, target]);
  }

  const symbolCount = fsm.atoms.filter(
    (a) => a.kind === "symbol" || a.kind === "method"
  ).length;

  return {
    floors,
    edges: { imports: importEdges, calls: callEdges },
    summary: {
      project_name:     fsm.project_name,
      project_root:     fsm.project_root,
      total_files:      fsm.total_files,
      total_dirs:       fsm.total_dirs,
      captured_at:      fsm.captured_at,
      language_profile: fsm.language_profile,
      floor_count:      Object.keys(floors).length,
      symbol_count:     symbolCount,
    },
  };
}

// Result of a successful boot — caller can stop both transports.
export interface RunningServer {
  server:  http.Server;
  port:    number;
  stop:    () => Promise<void>;
  explorer: SpatialTetherFileExplorer;
}

// Read the file content for an atom, capped to keep the wire payload sane.
// Caller passes the project root because FSMAtom no longer carries `path`.
function readAtomContent(atom: FSMAtom, projectRoot: string): string | null {
  if (atom.kind !== "file") return null;
  try {
    const abs = path.join(projectRoot, atom.rel_path);
    const stat = fs.statSync(abs);
    if (stat.size > 1024 * 1024) return null; // 1 MB hard cap
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export async function startHttpServer(
  projectRoot: string,
  options: HttpServerOptions = {},
): Promise<RunningServer> {
  const port = options.port ?? 3000;
  const host = options.host ?? "127.0.0.1";

  const projectRootResolved = path.resolve(projectRoot);
  const explorer = new SpatialTetherFileExplorer(projectRootResolved);
  explorer.scan();

  // Security: reject any user-supplied path that resolves outside the project
  // root (path traversal). Used by /api/atom, /api/room, /api/enter_room,
  // /api/request_file. Returns true when the rel_path is safe.
  const isSafeRelPath = (rel: string): boolean => {
    if (typeof rel !== "string" || rel.length === 0) return false;
    if (rel.includes("\0")) return false;
    // Strip a `#symbol` suffix (used for symbol rel_paths) before resolution
    const cleaned = rel.split("#")[0];
    const resolved = path.resolve(projectRootResolved, cleaned);
    const projectWithSep = projectRootResolved.endsWith(path.sep)
      ? projectRootResolved
      : projectRootResolved + path.sep;
    return resolved === projectRootResolved || resolved.startsWith(projectWithSep);
  };
  // Auto-create a session so the UI can navigate immediately. The /api/session
  // endpoint surfaces it; start_session-style resets are not exposed here.
  if (!explorer.currentSession()) explorer.startSession();
  // Watch the project so chokidar feeds change events into refresh().
  explorer.watch();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Tiny CORS so the Vite dev server can hit us across ports without a proxy
  // when we want to. The proxy is the recommended path; this is the safety
  // net for someone who skips proxy configuration.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  app.get("/api/fsm", (_req: Request, res: Response) => {
    res.json(snapshotFromFSM(explorer.getManifest()));
  });

  app.get("/api/room", (req: Request, res: Response) => {
    const focus = String(req.query.focus ?? "");
    const depth = req.query.depth != null ? Number(req.query.depth) : 2;
    if (!focus) { res.status(400).json({ error: "focus is required" }); return; }
    if (!isSafeRelPath(focus)) {
      res.status(400).json({ error: "focus path escapes project root" });
      return;
    }
    if (!Number.isFinite(depth) || depth < 0 || depth > 16) {
      res.status(400).json({ error: "depth must be 0..16" });
      return;
    }
    res.json(explorer.getRoom(focus, depth));
  });

  app.post("/api/enter_room", (req: Request, res: Response) => {
    const { focus, depth_limit } = req.body ?? {};
    if (!focus || typeof focus !== "string") {
      res.status(400).json({ error: "focus is required" });
      return;
    }
    if (!isSafeRelPath(focus)) {
      res.status(400).json({ error: "focus path escapes project root" });
      return;
    }
    const dl = typeof depth_limit === "number" ? depth_limit : 2;
    if (!Number.isFinite(dl) || dl < 0 || dl > 16) {
      res.status(400).json({ error: "depth_limit must be 0..16" });
      return;
    }
    const room = explorer.getRoom(focus, dl);
    broadcast(wss, { type: "room_change", current_room: focus });
    res.json(room);
  });

  // Internal screensaver navigation. Updates the session's current_room +
  // history, returns the room JSON, and — critically — does NOT broadcast
  // over WebSocket. The UI's auto-explore tour calls this so its visualiza-
  // tion-only steps never look like an external agent (LIVE) signal.
  app.post("/api/demo_step", (req: Request, res: Response) => {
    const { rel_path } = req.body ?? {};
    if (!rel_path || typeof rel_path !== "string") {
      res.status(400).json({ error: "rel_path is required" });
      return;
    }
    if (!isSafeRelPath(rel_path)) {
      res.status(400).json({ error: "rel_path escapes project root" });
      return;
    }
    const session = explorer.currentSession();
    if (!session) { res.status(400).json({ error: "no active session" }); return; }
    const room = session.enterRoom(rel_path, 2);
    // No broadcast(...) call here on purpose — that's the whole point.
    res.json(room);
  });

  // External-caller integration hook. Same effect as /api/enter_room but
  // explicitly tagged for tooling that wants to signal "an external caller
  // just looked at this file" (so the UI can distinguish it from a user-
  // driven navigation). Goes through session.enterRoom so navigation
  // history is recorded.
  app.post("/api/agent_focus", (req: Request, res: Response) => {
    const { rel_path, tool, session_id } = req.body ?? {};
    if (!rel_path || typeof rel_path !== "string") {
      res.status(400).json({ error: "rel_path is required" });
      return;
    }
    if (!isSafeRelPath(rel_path)) {
      res.status(400).json({ error: "rel_path escapes project root" });
      return;
    }
    const session = explorer.currentSession();
    if (!session) { res.status(400).json({ error: "no active session" }); return; }
    const room = session.enterRoom(rel_path);
    broadcast(wss, { type: "room_change", current_room: rel_path });
    res.json({ ok: true, tool: tool ?? null, session_id: session_id ?? null, room });
  });

  app.post("/api/request_file", (req: Request, res: Response) => {
    const { rel_path, justification } = req.body ?? {};
    if (!rel_path || typeof rel_path !== "string") {
      res.status(400).json({ error: "rel_path is required" });
      return;
    }
    if (!isSafeRelPath(rel_path)) {
      // Path traversal attempt — record as denial, do NOT proceed.
      res.status(400).json({
        granted: false,
        outcome: "denied",
        error: "rel_path escapes project root",
      });
      return;
    }
    if (justification != null && typeof justification !== "string") {
      res.status(400).json({ error: "justification must be a string" });
      return;
    }
    const session = explorer.currentSession();
    if (!session) { res.status(400).json({ error: "no active session" }); return; }
    const result = session.requestFile(rel_path, justification);
    broadcast(wss, {
      type: "investigation",
      rel_path,
      granted: result.granted,
      outcome: result.outcome,
    });
    res.json(result);
  });

  app.get("/api/session", (_req: Request, res: Response) => {
    const session = explorer.currentSession();
    if (!session) { res.status(404).json({ error: "no active session" }); return; }
    res.json(session.serialize());
  });

  // Wipe navigation history. The UI exposes this as a "↺ RESET" button —
  // the escape hatch when the trail / visited set has accumulated noise the
  // user wants to clear. Broadcasts session_reset so every connected client
  // (and other tabs) drops their derived state in lockstep.
  app.post("/api/reset_session", (_req: Request, res: Response) => {
    const session = explorer.currentSession();
    if (!session) { res.status(400).json({ error: "no active session" }); return; }
    session.clearHistory();
    broadcast(wss, { type: "session_reset" });
    res.json({ ok: true });
  });

  app.get("/api/atom", (req: Request, res: Response) => {
    const id = req.query.id != null ? String(req.query.id) : null;
    const relPath = req.query.rel_path != null ? String(req.query.rel_path) : null;
    if (!id && !relPath) {
      res.status(400).json({ error: "id or rel_path is required" });
      return;
    }
    if (relPath && !isSafeRelPath(relPath)) {
      res.status(400).json({ error: "rel_path escapes project root" });
      return;
    }
    const fsm = explorer.getManifest();
    const atom = id
      ? fsm.atoms.find((a) => a.id === id) ?? null
      : explorer.getAtom(relPath!);
    if (!atom) { res.status(404).json({ error: "atom not found" }); return; }
    res.json({ atom, content: readAtomContent(atom, projectRootResolved) });
  });

  // ── File read/write — feeds the in-UI scroll editor ─────────────────────

  app.get("/api/file", (req: Request, res: Response) => {
    const rel = req.query.path != null ? String(req.query.path) : "";
    if (!rel) { res.status(400).json({ error: "path is required" }); return; }
    if (!isSafeRelPath(rel)) {
      res.status(400).json({ error: "path escapes project root" });
      return;
    }
    const abs = path.resolve(projectRootResolved, rel);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) { res.status(400).json({ error: "not a file" }); return; }
      // 2 MB cap — the UI editor isn't designed for very large files.
      if (stat.size > 2 * 1024 * 1024) {
        res.status(413).json({ error: "file too large" });
        return;
      }
      const content = fs.readFileSync(abs, "utf8");
      res.json({
        path:    rel,
        content,
        lines:   content.split("\n").length,
        size:    stat.size,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
      const status = code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: code });
    }
  });

  app.post("/api/file", (req: Request, res: Response) => {
    const { path: rel, content } = req.body ?? {};
    if (!rel || typeof rel !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    if (!isSafeRelPath(rel)) {
      res.status(400).json({ error: "path escapes project root" });
      return;
    }
    const abs = path.resolve(projectRootResolved, rel);
    try {
      fs.writeFileSync(abs, content, "utf8");
      // Trigger an incremental refresh so the FSM picks up the new mtime.
      // The watcher will also pick this up; doing it inline guarantees the
      // first response after write reflects the new state.
      try { explorer.refresh(); } catch { /* tolerate refresh hiccups */ }
      res.json({ ok: true, path: rel, written_at: new Date().toISOString() });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
      res.status(500).json({ ok: false, error: code });
    }
  });

  // Local-only git ledger. Whitelist of read-only and local-write commands.
  // Never push, pull, checkout, reset, fetch, merge, rebase, branch, tag.
  app.post("/api/git", (req: Request, res: Response) => {
    const { command, message } = req.body ?? {};
    if (typeof command !== "string") {
      res.status(400).json({ ok: false, error: "command is required" });
      return;
    }
    let args: string[];
    switch (command) {
      case "status": args = ["status", "--short"]; break;
      case "diff":   args = ["diff", "--stat"];    break;
      case "add":    args = ["add", "-A"];         break;
      case "log":    args = ["log", "--oneline", "-10"]; break;
      case "commit":
        if (typeof message !== "string" || message.trim().length === 0) {
          res.status(400).json({ ok: false, error: "commit message is required" });
          return;
        }
        // Cap message length; pass via execFile arg array (no shell, so the
        // message can contain any characters safely).
        if (message.length > 4096) {
          res.status(400).json({ ok: false, error: "commit message too long" });
          return;
        }
        args = ["commit", "-m", message];
        break;
      default:
        res.status(400).json({ ok: false, error: `command not in whitelist: ${command}` });
        return;
    }

    execFile("git", args, { cwd: projectRootResolved, timeout: 10_000 }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      // execFile reports a non-zero exit as err with err.code = exit code.
      const exitCode = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? Number((err as NodeJS.ErrnoException).code)
        : err ? 1 : 0;
      // Detect "not a git repository" by stderr signature
      if (exitCode !== 0 && /not a git repository/i.test(stderr || "")) {
        res.json({ ok: false, command, output: out, exit_code: exitCode, error: "not a git repository" });
        return;
      }
      res.json({
        ok:        exitCode === 0,
        command,
        output:    out,
        exit_code: exitCode,
      });
    });
  });

  // ── HTTP + WS plumbing ───────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket) => {
    // Send the init payload immediately on connect so the UI can render
    // without an extra round-trip.
    safeSend(socket, {
      type: "init",
      fsm:  snapshotFromFSM(explorer.getManifest()),
    });
  });

  // Watcher → broadcast `update` events.
  explorer.events.on("update", (e: FSMUpdateEvent) => {
    if (e.changed_atoms.length > 0) {
      broadcast(wss, { type: "update", changed_atoms: e.changed_atoms });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      console.log(`[spatial-tether] http://${displayHost}:${port}`);
      if (options.openBrowser) {
        openBrowser(`http://${displayHost}:${port}`);
      }
      resolve();
    });
  });

  const stop = async () => {
    await new Promise<void>((resolve, reject) => {
      // Closing the WSS first prevents a race where new sockets attach to
      // a server we've already started shutting down.
      wss.close(() => server.close((err) => (err ? reject(err) : resolve())));
      // Force-close any lingering sockets after a grace period.
      setTimeout(() => {
        for (const c of wss.clients) c.terminate();
      }, 200).unref();
    });
    await explorer.unwatch();
  };

  return { server, port, stop, explorer };
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(payload)); } catch { /* swallow */ }
}

function broadcast(wss: WebSocketServer, payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch { /* swallow */ }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI — `npx spatial-tether-ui /path/to/project [--port 3000]`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const projectRoot = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const portIdx = args.findIndex((a) => a === "--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3000;
  // Default localhost-only. Pass `--host 0.0.0.0` to expose on the network —
  // remember the server can read/write files and run git commit, so only do
  // that on a trusted LAN.
  const hostIdx = args.findIndex((a) => a === "--host");
  const host = hostIdx >= 0 ? String(args[hostIdx + 1]) : "127.0.0.1";
  if (!fs.existsSync(projectRoot)) {
    console.error(`Path does not exist: ${projectRoot}`);
    process.exit(1);
  }

  // CLI default: open the browser. Disable with --no-open.
  const openBrowserFlag = !args.includes("--no-open");
  startHttpServer(projectRoot, { port, host, openBrowser: openBrowserFlag }).then(({ port: actual }) => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.error(`[spatial-tether-ui] listening on http://${displayHost}:${actual}`);
    console.error(`[spatial-tether-ui] project: ${path.resolve(projectRoot)}`);
  }).catch((err) => {
    console.error("[spatial-tether-ui] failed to start:", err);
    process.exit(1);
  });
}
