import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import { walkProject, WalkOptions } from "./fs-walker";
import { buildFSM, buildRoom, roomToText } from "./fs-engine";
import { FSM, FSMRoom, FSMAtom, SessionSnapshot } from "./fs-manifest";
import { Session, SessionGateway } from "./session";
import {
  dumpFSM, loadFSM, dumpSession, loadSessionSnapshot,
  defaultFSMPath, defaultSessionPath,
} from "./persist";
import {
  startWatcher, FSMUpdateEvent, RefreshDiff, Watcher,
} from "./watcher";

export interface IncrementalRefreshResult {
  added: string[];      // atom IDs newly added
  updated: string[];    // atom IDs whose source mtime changed
  removed: string[];    // atom IDs whose source no longer exists
}

// ---------------------------------------------------------------------------
// SpatialTetherFileExplorer
// Drop-in for any caller that wants a code-aware view of a project. Returns:
//   - The full FSM (for callers with a large context window)
//   - Room descriptions (a bounded view for callers with a small one)
//   - A Session, when started, that enforces the Investigation Check
//   - Persistence — save/load + incremental refresh + watcher
// ---------------------------------------------------------------------------
export class SpatialTetherFileExplorer implements SessionGateway {
  private fsm: FSM | null = null;
  private projectRoot: string;
  private options: WalkOptions;
  private session: Session | null = null;
  private watcher: Watcher | null = null;
  // Phase 7 perf — O(1) atom-by-id lookup for getSymbol / findCallers /
  // findCallees / getAtom. Rebuilt on every scan() / refresh() / load().
  private idIndex: Map<string, FSMAtom> = new Map();
  private relPathIndex: Map<string, FSMAtom> = new Map();

  private rebuildIndices(): void {
    this.idIndex.clear();
    this.relPathIndex.clear();
    if (!this.fsm) return;
    for (const a of this.fsm.atoms) {
      this.idIndex.set(a.id, a);
      this.relPathIndex.set(a.rel_path, a);
    }
  }
  // Public emitter — consumers (HTTP/WS server, tests) subscribe to "update"
  // events of shape FSMUpdateEvent. Errors fire on "error".
  readonly events = new EventEmitter();

  // Public read-only accessor — used by Session, http-server, and any caller
  // that needs to reconstruct an absolute path from a relative one.
  getProjectRoot(): string { return this.projectRoot; }

  constructor(projectRoot: string, options: WalkOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.options = options;
  }

  // Scan the project and build the FSM.
  // Call this once at session start, then refresh on file changes.
  scan(): FSM {
    const nodes = walkProject(this.projectRoot, this.options);
    this.fsm = buildFSM(this.projectRoot, nodes, {
      gravity: this.options.gravity_weights,
    });
    this.rebuildIndices();
    return this.fsm;
  }

  // Force a full re-scan (no incremental shortcuts).
  fullScan(): FSM {
    return this.scan();
  }

  // Get the full manifest.
  getManifest(): FSM {
    if (!this.fsm) this.scan();
    return this.fsm!;
  }

  // Get a Room Description for the agent's current focus.
  // When a session is attached, this routes through the session so that
  // navigation history is updated and gravity reflects session signals.
  getRoom(focusPath: string, depthLimit = 2): FSMRoom {
    if (!this.fsm) this.scan();
    if (this.session) {
      return this.session.enterRoom(focusPath, depthLimit);
    }
    return buildRoom(this.fsm!, focusPath, depthLimit);
  }

  // Plain-English room description — what the coding agent reads.
  describeRoom(focusPath: string, depthLimit = 2): string {
    const room = this.getRoom(focusPath, depthLimit);
    return roomToText(room, this.fsm!.project_name, this.session);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  // Create and attach a new Session. Returns the Session for the caller to
  // hold a reference if needed.
  startSession(): Session {
    if (!this.fsm) this.scan();
    this.session = new Session(this);
    return this.session;
  }

  // Attach a previously-restored Session.
  attachSession(s: Session): void {
    this.session = s;
  }

  currentSession(): Session | null {
    return this.session;
  }

  // Detach and return a snapshot of the current session.
  endSession(): SessionSnapshot | null {
    if (!this.session) return null;
    const snap = this.session.serialize();
    this.session = null;
    return snap;
  }

  // Get a single atom by relative or absolute path.
  // Security (Phase 7): rel_path inputs are resolved against projectRoot and
  // rejected if they escape. Absolute paths are matched as-is against the
  // FSM (already-known atoms only — there's no way for a caller to introduce
  // a new path through this method).
  getAtom(filePath: string) {
    if (!this.fsm) this.scan();
    if (typeof filePath !== "string" || filePath.length === 0) return null;
    if (filePath.includes("\0")) return null;

    if (path.isAbsolute(filePath)) {
      // Absolute path must be inside projectRoot
      const projectWithSep = this.projectRoot.endsWith(path.sep)
        ? this.projectRoot
        : this.projectRoot + path.sep;
      if (filePath !== this.projectRoot && !filePath.startsWith(projectWithSep)) {
        return null;
      }
      // O(1) — convert to rel and look up via the canonical index.
      const rel = filePath === this.projectRoot
        ? "."
        : path.relative(this.projectRoot, filePath);
      return this.relPathIndex.get(rel) ?? null;
    }

    // Relative path: must resolve inside projectRoot
    const resolved = path.resolve(this.projectRoot, filePath);
    const projectWithSep = this.projectRoot.endsWith(path.sep)
      ? this.projectRoot
      : this.projectRoot + path.sep;
    if (resolved !== this.projectRoot && !resolved.startsWith(projectWithSep)) {
      return null;
    }
    return this.relPathIndex.get(filePath) ?? null;
  }

  // Find files whose name or rel_path matches a substring (case-insensitive)
  // or a glob-like pattern with `*` wildcards. Backs the find_file MCP tool.
  // Symbols and dirs are excluded — use findSymbol for symbols.
  findFile(pattern: string, limit = 50) {
    if (!this.fsm) this.scan();
    const needle = pattern.toLowerCase();

    // Compile glob-ish pattern to regex if it contains `*`; otherwise substring match
    const matcher = needle.includes("*")
      ? new RegExp(
          "^" +
            needle
              .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metas (not *)
              .replace(/\*/g, ".*") +
            "$"
        )
      : null;

    const results = this.fsm!.atoms.filter((a) => {
      if (a.kind !== "file") return false;
      const name    = a.name.toLowerCase();
      const relPath = a.rel_path.toLowerCase();
      return matcher
        ? matcher.test(name) || matcher.test(relPath)
        : name.includes(needle) || relPath.includes(needle);
    });

    return results
      .sort((a, b) => b.gravity - a.gravity)
      .slice(0, limit);
  }

  // Find symbols (or methods) whose name matches. Optional kind filter.
  // Returns gravity-sorted list capped at limit.
  findSymbol(
    pattern: string,
    options: { kind?: import("./fs-manifest").SymbolKind; limit?: number } = {}
  ) {
    if (!this.fsm) this.scan();
    const limit  = options.limit ?? 50;
    const needle = pattern.toLowerCase();

    const matcher = needle.includes("*")
      ? new RegExp(
          "^" +
            needle.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
            "$"
        )
      : null;

    const results = this.fsm!.atoms.filter((a) => {
      if (a.kind !== "symbol" && a.kind !== "method") return false;
      if (options.kind && a.symbol_kind !== options.kind) return false;
      const name = a.name.toLowerCase();
      return matcher ? matcher.test(name) : name.includes(needle);
    });

    return results
      .sort((a, b) => b.gravity - a.gravity)
      .slice(0, limit);
  }

  // Get a single symbol by atom ID or by qualified rel_path
  // (e.g. "src/auth.ts#verifyToken" or "src/db.ts#Connection.query").
  // O(1) via the rebuilt id/rel_path indices.
  getSymbol(idOrRelPath: string) {
    if (!this.fsm) this.scan();
    const byId = this.idIndex.get(idOrRelPath);
    if (byId && (byId.kind === "symbol" || byId.kind === "method")) return byId;
    const byRel = this.relPathIndex.get(idOrRelPath);
    if (byRel && (byRel.kind === "symbol" || byRel.kind === "method")) return byRel;
    return null;
  }

  // Find callers of a symbol: symbol atoms that reference this symbol.
  // Accepts atom ID or qualified rel_path. Returns gravity-sorted list.
  // Phase 7 perf — O(callers) via id index instead of O(n) via fsm.atoms.filter.
  findCallers(idOrRelPath: string): FSMAtom[] {
    if (!this.fsm) this.scan();
    const target = this.getSymbol(idOrRelPath);
    if (!target) return [];
    const out: FSMAtom[] = [];
    for (const id of target.referenced_by) {
      const a = this.idIndex.get(id);
      if (a) out.push(a);
    }
    return out.sort((a, b) => b.gravity - a.gravity);
  }

  // Find callees of a symbol: symbol atoms that this symbol references.
  // Accepts atom ID or qualified rel_path. Returns gravity-sorted list.
  // Phase 7 perf — O(callees) via id index.
  findCallees(idOrRelPath: string): FSMAtom[] {
    if (!this.fsm) this.scan();
    const target = this.getSymbol(idOrRelPath);
    if (!target) return [];
    const out: FSMAtom[] = [];
    for (const id of target.references) {
      const a = this.idIndex.get(id);
      if (a) out.push(a);
    }
    return out.sort((a, b) => b.gravity - a.gravity);
  }

  // Compute the structural relationship between two atoms without paying the
  // cost of materializing two full Rooms. O(symbols-per-file + shared-importers).
  // Replaces the expensive `getRoom × 2 + manual diff` pattern that the Q4
  // benchmark methodology used to require.
  //
  // Each side is identified by atom id OR rel_path (file or symbol). For file
  // atoms, the call-graph edges are aggregated across all symbols defined in
  // the file (via parent_id chain → file ancestor). For symbol atoms, the
  // edges are read directly off the symbol's references / referenced_by.
  getRelationship(idOrRelPathA: string, idOrRelPathB: string): {
    a: { id: string; rel_path: string } | null;
    b: { id: string; rel_path: string } | null;
    a_imports_b: boolean;
    b_imports_a: boolean;
    shared_importers: string[];
    a_calls_b: string[];   // symbol atom IDs in A that reference any symbol in B
    b_calls_a: string[];
  } {
    if (!this.fsm) this.scan();

    // Resolve each side: prefer id, fall back to rel_path
    const resolve = (key: string): FSMAtom | null => {
      const byId = this.idIndex.get(key);
      if (byId) return byId;
      return this.relPathIndex.get(key) ?? null;
    };
    const atomA = resolve(idOrRelPathA);
    const atomB = resolve(idOrRelPathB);
    const empty = {
      a: atomA ? { id: atomA.id, rel_path: atomA.rel_path } : null,
      b: atomB ? { id: atomB.id, rel_path: atomB.rel_path } : null,
      a_imports_b: false, b_imports_a: false,
      shared_importers: [],
      a_calls_b: [], b_calls_a: [],
    };
    if (!atomA || !atomB) return empty;

    // ── File-level edges
    const a_imports_b = atomA.import_refs.includes(atomB.id);
    const b_imports_a = atomB.import_refs.includes(atomA.id);

    // Shared importers: find files whose import_refs contains BOTH ids.
    // O(N) over file atoms; cheap relative to two getRoom calls.
    const shared_importers: string[] = [];
    for (const a of this.fsm!.atoms) {
      if (a.kind !== "file") continue;
      if (a.id === atomA.id || a.id === atomB.id) continue;
      if (a.import_refs.includes(atomA.id) && a.import_refs.includes(atomB.id)) {
        shared_importers.push(a.id);
      }
    }

    // ── Symbol-level edges (call graph)
    // Collect all symbol atoms whose owning file is A (or A itself if A is a symbol).
    const fileOf = (atom: FSMAtom): string => {
      if (atom.kind === "file" || atom.kind === "dir") return atom.id;
      let walker: FSMAtom | undefined = atom;
      while (walker && walker.kind !== "file" && walker.parent_id) {
        walker = this.idIndex.get(walker.parent_id);
      }
      return walker?.id ?? atom.id;
    };
    const symsOfFile = (fileId: string): FSMAtom[] => {
      const out: FSMAtom[] = [];
      for (const a of this.fsm!.atoms) {
        if (a.kind !== "symbol" && a.kind !== "method") continue;
        if (fileOf(a) === fileId) out.push(a);
      }
      return out;
    };

    const aFileId = fileOf(atomA);
    const bFileId = fileOf(atomB);
    const aSyms = symsOfFile(aFileId);
    const bSyms = symsOfFile(bFileId);
    const bSymIds = new Set(bSyms.map((s) => s.id));
    const aSymIds = new Set(aSyms.map((s) => s.id));

    const a_calls_b: string[] = [];
    for (const sym of aSyms) {
      for (const ref of sym.references) {
        if (bSymIds.has(ref)) { a_calls_b.push(sym.id); break; }
      }
    }
    const b_calls_a: string[] = [];
    for (const sym of bSyms) {
      for (const ref of sym.references) {
        if (aSymIds.has(ref)) { b_calls_a.push(sym.id); break; }
      }
    }

    return {
      a: { id: atomA.id, rel_path: atomA.rel_path },
      b: { id: atomB.id, rel_path: atomB.rel_path },
      a_imports_b,
      b_imports_a,
      shared_importers,
      a_calls_b,
      b_calls_a,
    };
  }

  // Summary for the agent's opening context — the dungeon entrance.
  summarize(): string {
    if (!this.fsm) this.scan();
    const fsm = this.fsm!;
    const lines: string[] = [
      `=== PROJECT: ${fsm.project_name} ===`,
      `Root: ${fsm.project_root}`,
      `Files: ${fsm.total_files}  Dirs: ${fsm.total_dirs}`,
      `Scanned: ${fsm.captured_at}`,
      "",
      "Language profile:",
    ];

    const sorted = Object.entries(fsm.language_profile)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [ext, count] of sorted) {
      lines.push(`  ${ext.padEnd(12)} ${count} files`);
    }

    lines.push("");
    lines.push("Entry points:");
    const entries = fsm.atoms.filter((a) => a.meta.is_entry);
    if (entries.length === 0) {
      lines.push("  (none detected)");
    } else {
      for (const e of entries) {
        lines.push(`  ${e.rel_path}`);
      }
    }

    lines.push("");
    lines.push("High-gravity files (top 10):");
    const topFiles = [...fsm.atoms]
      .filter((a) => a.kind === "file")
      .sort((a, b) => b.gravity - a.gravity)
      .slice(0, 10);
    for (const n of topFiles) {
      lines.push(`  [${n.gravity}] ${n.rel_path}`);
    }

    const symbolCount = fsm.atoms.filter(
      (a) => a.kind === "symbol" || a.kind === "method"
    ).length;
    if (symbolCount > 0) {
      lines.push("");
      lines.push(`Symbols indexed: ${symbolCount}`);
    }

    return lines.join("\n");
  }

  // Incremental refresh. Walks the project, reuses unchanged atoms, only
  // re-extracts symbols/imports for files whose mtime moved. Returns a diff
  // of atom IDs partitioned by added / updated / removed.
  //
  // For the watcher, the diff feeds the `update` event payload. For test
  // assertions, the diff is the contract — only changed files appear in
  // `updated`.
  refresh(): IncrementalRefreshResult {
    if (!this.fsm) {
      this.scan();
      return { added: [], updated: [], removed: [] };
    }

    const prevFsm = this.fsm;
    const prevByRelPath = new Map<string, FSMAtom>();
    const prevByAtomId = new Map<string, FSMAtom>();
    const existingAtoms = new Map<string, { mtime_ms: number; line_count: number }>();
    for (const a of prevFsm.atoms) {
      prevByAtomId.set(a.id, a);
      if (a.kind === "file") {
        prevByRelPath.set(a.rel_path, a);
        existingAtoms.set(a.rel_path, {
          mtime_ms: a.mtime_ms,
          line_count: a.geom.h,
        });
      }
    }

    const nodes = walkProject(this.projectRoot, {
      ...this.options,
      existing_atoms: existingAtoms,
    });

    this.fsm = buildFSM(this.projectRoot, nodes, {
      gravity: this.options.gravity_weights,
      previous: prevFsm,
    });
    this.rebuildIndices();

    // Diff at the file level (symbols are derived; their changes mirror their parent files)
    const newByRelPath = new Map<string, FSMAtom>();
    for (const a of this.fsm.atoms) {
      if (a.kind === "file") newByRelPath.set(a.rel_path, a);
    }

    const added:   string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [relPath, newAtom] of newByRelPath) {
      const prev = prevByRelPath.get(relPath);
      if (!prev) {
        added.push(newAtom.id);
      } else if (prev.mtime_ms !== newAtom.mtime_ms) {
        updated.push(newAtom.id);
      }
    }
    for (const [relPath, prev] of prevByRelPath) {
      if (!newByRelPath.has(relPath)) {
        removed.push(prev.id);
      }
    }

    if (this.session) {
      // Session-modified detection runs against the new FSM.
      this.session.detectModifications();
    }

    return { added, updated, removed };
  }

  // -------------------------------------------------------------------------
  // Persistence — Phase 4
  // -------------------------------------------------------------------------

  // Save the current FSM to JSON. Defaults to <projectRoot>/.spatial-tether/fsm.json.
  // Caller is responsible for awaiting before relying on the file existing.
  async save(filePath?: string): Promise<{ path: string; bytes: number }> {
    const target = filePath ?? defaultFSMPath(this.projectRoot);
    const fsm = this.getManifest();
    const result = await dumpFSM(fsm, target);
    return { path: target, bytes: result.bytes };
  }

  // Load the FSM from JSON. On version mismatch, missing file, or parse
  // error, falls back to a full scan and returns `{ loaded: false, reason }`.
  async load(filePath?: string): Promise<{
    loaded: boolean;
    reason?: "missing" | "version_mismatch" | "parse_error" | "io_error";
    fellback_to_scan?: boolean;
  }> {
    const target = filePath ?? defaultFSMPath(this.projectRoot);
    const result = await loadFSM(target);
    if (result.fsm) {
      this.fsm = result.fsm;
      // rel_path is canonical and project-root-independent; absolute paths are
      // reconstructed on demand by callers (atomAbsPath / getProjectRoot).
      this.fsm.project_root = this.projectRoot;
      this.rebuildIndices();
      return { loaded: true };
    }
    // Fall back to a full scan so the caller has a usable FSM either way.
    this.scan();
    return { loaded: false, reason: result.reason, fellback_to_scan: true };
  }

  // Save the active session snapshot. Throws if no session is attached.
  async saveSession(filePath?: string): Promise<{ path: string }> {
    if (!this.session) throw new Error("no active session to save");
    const target = filePath ?? defaultSessionPath(this.projectRoot);
    await dumpSession(this.session.serialize(), target);
    return { path: target };
  }

  // Load and attach a session snapshot. Replaces any current session.
  async loadSession(filePath?: string): Promise<{ loaded: boolean }> {
    const target = filePath ?? defaultSessionPath(this.projectRoot);
    const snap = await loadSessionSnapshot(target);
    if (!snap) return { loaded: false };
    this.session = Session.restore(snap, this);
    return { loaded: true };
  }

  // -------------------------------------------------------------------------
  // File watcher — Phase 4
  // -------------------------------------------------------------------------

  // Start watching the project root. Subsequent file changes call `refresh()`
  // and emit `update` events on `this.events`.
  watch(projectRoot?: string): { stop: () => Promise<void> } {
    if (this.watcher) return this.watcher;
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;
    this.watcher = startWatcher(
      root,
      () => this.refresh(),
      this.events,
    );
    return this.watcher;
  }

  async unwatch(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.stop();
    this.watcher = null;
  }
}

// Re-export so consumers don't need a separate import.
export type { FSMUpdateEvent, RefreshDiff };

// ---------------------------------------------------------------------------
// MCP-compatible tool definitions
// These map to the tools the coding agent can invoke.
// ---------------------------------------------------------------------------
export const FILE_EXPLORER_TOOLS = [
  {
    name: "get_room",
    description:
      "Get a spatial Room Description for a file or directory. " +
      "Use this to understand what's near your current focus before editing. " +
      "depth_limit controls the Encumbrance window (default: 2).",
    input_schema: {
      type: "object",
      properties: {
        focus_path: {
          type: "string",
          description: "Relative path from project root (e.g. 'src/engine.ts')",
        },
        depth_limit: {
          type: "number",
          description: "How many depth levels to include. Default 2.",
        },
      },
      required: ["focus_path"],
    },
  },
  {
    name: "get_project_summary",
    description:
      "Get a full project overview: entry points, language profile, high-gravity nodes. " +
      "Use this at session start to orient yourself before touching any files.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "find_file",
    description:
      "Find a specific file by name pattern. Substring match by default; " +
      "supports glob `*` wildcards. Returns gravity-sorted list of file atoms.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "File name or partial path to search for.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default 50.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Find symbols (functions, classes, methods, types, interfaces, enums, " +
      "consts) by name. Substring match by default; supports `*` wildcards. " +
      "Optional kind filter narrows results. Returns gravity-sorted list.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Symbol name to search for.",
        },
        kind: {
          type: "string",
          enum: ["function", "class", "method", "const", "var", "type", "interface", "enum"],
          description: "Optional symbol kind filter.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default 50.",
        },
      },
      required: ["pattern"],
    },
  },
];

// ---------------------------------------------------------------------------
// CLI — run directly to scan a project and print summary
// Usage: npx ts-node src/gateway.ts /path/to/project [focus_path]
// ---------------------------------------------------------------------------
if (require.main === module) {
  const projectRoot = process.argv[2];
  const focusPath   = process.argv[3];

  if (!projectRoot) {
    console.error("Usage: ts-node src/gateway.ts <project_root> [focus_path]");
    process.exit(1);
  }

  if (!fs.existsSync(projectRoot)) {
    console.error(`Path does not exist: ${projectRoot}`);
    process.exit(1);
  }

  const explorer = new SpatialTetherFileExplorer(projectRoot);

  console.log("Scanning...\n");
  explorer.scan();

  console.log(explorer.summarize());

  if (focusPath) {
    console.log("\n" + "─".repeat(60) + "\n");
    console.log(explorer.describeRoom(focusPath));
  }
}
