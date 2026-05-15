import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// File roles — what kind of node is this in the project?
// ---------------------------------------------------------------------------
export type FileRole =
  | "dir"          // directory
  | "source"       // .ts, .js, .py, .rs, .go, .c, .cpp, etc.
  | "test"         // *.test.*, *.spec.*, __tests__/
  | "config"       // package.json, tsconfig, .env, Dockerfile, etc.
  | "doc"          // README, .md, .txt
  | "asset"        // images, fonts, static
  | "schema"       // .sql, .graphql, .proto, .json schema
  | "build"        // dist/, out/, .lock files
  | "unknown";

// ---------------------------------------------------------------------------
// File intent — what does this node DO in the project?
// ---------------------------------------------------------------------------
export type FileIntent =
  | "entry"        // index.*, main.*, app.*  — the door
  | "module"       // a discrete unit of logic
  | "gateway"      // api/, routes/, handlers/ — boundary layer
  | "model"        // types/, models/, schema/ — shape of data
  | "test"         // verification
  | "config"       // project configuration
  | "doc"          // human documentation
  | "build"        // compilation artifact
  | "unknown";

// ---------------------------------------------------------------------------
// AtomKind — what structural category does this atom belong to?
//   dir     — directory in the filesystem
//   file    — file in the filesystem
//   symbol  — top-level declaration inside a file (function, class, const, ...)
//   method  — function inside a class
// ---------------------------------------------------------------------------
export type AtomKind = "dir" | "file" | "symbol" | "method";

// What kind of declaration a symbol/method atom represents.
export type SymbolKind =
  | "function" | "class" | "const" | "var"
  | "type" | "interface" | "enum" | "method";

// ---------------------------------------------------------------------------
// FSMAtom — a single node in the Filesystem Spatial Manifest.
// Geom repurposed:
//   x = depth in directory tree (0 = project root). For symbols, x = file depth.
//   y = sibling index (position among peers at this depth)
//   w = normalized file weight (0.0–1.0, based on size relative to project)
//   h = line count (0 for dirs and binary files; span height for symbols)
//
// 3D rendering fields:
//   parent_id      — atom ID of parent dir (or parent file/class for symbols)
//   siblings_total — total peers at this depth (normalize y to angle)
//   import_refs    — IDs of atoms this file imports (semantic edges)
//   temporal_score — 0.0–1.0, normalized recency (1.0 = most recently modified)
//   contains_refs  — IDs of children this atom contains (file → symbols, class → methods)
// ---------------------------------------------------------------------------
export interface FSMAtom {
  id: string;                    // deterministic: sha256(rel_path or rel_path#chain)
  kind: AtomKind;                // dir | file | symbol | method
  name: string;                  // file/dir name, or symbol name
  rel_path: string;              // relative path; symbols use rel_path#chain (e.g. "src/auth.ts#verifyToken")
  geom: { x: number; y: number; w: number; h: number };
  gravity: number;               // 0.0–1.0, how much context this node pulls
  parent_id: string | null;      // atom ID of parent dir/file/class (null for root)
  siblings_total: number;        // total peers — normalize: y/siblings_total * 2π for angle
  import_refs: string[];         // IDs of atoms this file imports
  contains_refs: string[];       // IDs of symbols/methods this atom contains
  references: string[];          // Phase 2b: IDs of symbols this symbol calls/references (call graph)
  referenced_by: string[];       // Phase 2b: IDs of symbols that call/reference this one
  temporal_score: number;        // 0.0–1.0, normalized recency across the project
  mtime_ms: number;              // Phase 4: ms-precision mtime (stat.mtimeMs); 0 for dirs/symbols whose source is the file
  // Symbol-only fields. Optional so file/dir atoms don't carry them.
  symbol_kind?: SymbolKind;
  span?: { start_line: number; end_line: number };
  exported?: boolean;
  meta: {
    role: FileRole;
    intent: FileIntent;
    ext: string;                 // ".ts", ".py", etc. — empty for dirs and symbols
    size_bytes: number;
    is_dir: boolean;
    is_entry: boolean;           // true if this is a known entry point
    children_count: number;      // 0 for files
  };
}

// Reconstruct an atom's absolute path from project root + rel_path.
// Symbols carry a `rel_path#chain` form; strip the suffix before joining.
// Caller supplies projectRoot (gateway / session / http-server have it in scope).
export function atomAbsPath(atom: FSMAtom, projectRoot: string): string {
  const fileRel = atom.rel_path.split("#")[0];
  if (fileRel === "" || fileRel === ".") return projectRoot;
  // Use require'd path module — keep this file dependency-light, so
  // re-export it via a lazy require so tests that mock fs/path don't break.
  const p: typeof import("path") = require("path");
  return p.join(projectRoot, fileRel);
}

// ---------------------------------------------------------------------------
// Why an atom appears in a Room.
//   focus         — the file/dir the agent is currently looking at
//   imports       — focus → this atom (this is what focus imports)
//   imported_by   — this atom → focus (this atom imports focus)
//   contains      — this atom is contained by focus (file → symbol, class → method)
//   depth_window  — within ±depth_limit of focus, no other relation
// ---------------------------------------------------------------------------
export type InclusionReason =
  | "focus" | "imports" | "imported_by" | "contains" | "depth_window";

// ---------------------------------------------------------------------------
// Session — Phase 3 types
// ---------------------------------------------------------------------------

// One leg of a navigation: when the agent entered focus_path and when it left.
export interface RoomVisit {
  focus_path: string;
  entered_at: string;          // ISO timestamp
  left_at: string | null;      // null while current
}

// Outcome of a `Session.requestFile` Investigation Check.
//   in_room              — atom is part of the current Room (free)
//   exit                 — atom is a Room exit (auto-granted, added to inventory)
//   in_inventory         — already paid the cost in this session
//   investigation_passed — outside Room, justification accepted
//   denied               — outside Room, no justification (or atom not found)
export type InvestigationOutcome =
  | "in_room"
  | "exit"
  | "in_inventory"
  | "investigation_passed"
  | "denied";

export interface InvestigationResult {
  granted: boolean;
  outcome: InvestigationOutcome;
  atom: FSMAtom | null;
  content: string | null;          // file contents when granted; null on denial
  justification?: string;
}

export interface InvestigationLogEntry {
  rel_path: string;
  outcome: InvestigationOutcome;
  justification?: string;
  at: string;                      // ISO timestamp
}

export interface SessionSnapshot {
  started_at: string;
  current_room: string | null;
  history: RoomVisit[];
  inventory: string[];                       // atom IDs
  session_modified: string[];                // atom IDs
  investigation_log: InvestigationLogEntry[];
}

// ---------------------------------------------------------------------------
// Room — a bounded view of the manifest (the Encumbrance system)
// The agent is given a Room, not the whole dungeon.
// ---------------------------------------------------------------------------
export interface FSMRoom {
  focus_path: string;            // the file/dir the agent is currently in
  depth_limit: number;          // how many levels from focus are visible
  atoms: FSMAtom[];              // depth-window + import-pulled neighbors
  breadcrumb: string[];          // path from root to focus
  exits: FSMAtom[];              // immediate children + siblings of focus
  inclusion: Record<string, InclusionReason>; // atom_id → why it's in the Room
}

// ---------------------------------------------------------------------------
// Gravity weights — tunable per project.
// All weights are additive; the final value is clamped to [0, 1].
// ---------------------------------------------------------------------------
export interface GravityWeights {
  role_base: Record<FileRole, number>;
  intent_bonus: Partial<Record<FileIntent, number>>;
  depth_penalty_per_level: number;
  depth_penalty_max: number;
  in_degree_weight: number;       // multiplied by normalized in-degree
  recency_weight: number;         // multiplied by temporal_score
}

export const DEFAULT_GRAVITY_WEIGHTS: GravityWeights = {
  role_base: {
    source:  0.70,
    schema:  0.65,
    config:  0.50,
    test:    0.40,
    doc:     0.30,
    dir:     0.20,
    build:   0.05,
    asset:   0.05,
    unknown: 0.10,
  },
  intent_bonus: {
    entry:   0.25,
    gateway: 0.15,
    model:   0.10,
  },
  depth_penalty_per_level: 0.04,
  depth_penalty_max:       0.30,
  in_degree_weight:        0.20,
  recency_weight:          0.10,
};

// ---------------------------------------------------------------------------
// FSM — the top-level Filesystem Spatial Manifest
// ---------------------------------------------------------------------------
export const FSM_VERSION = "1.0";

export interface FSM {
  fsm_version: string;            // "1.0" — bumped on incompatible schema changes
  tether_id: string;
  project_root: string;
  project_name: string;
  total_files: number;
  total_dirs: number;
  atoms: FSMAtom[];
  captured_at: string;
  language_profile: Record<string, number>; // ext -> file count
}

// ---------------------------------------------------------------------------
// Role inference from extension and path patterns
// ---------------------------------------------------------------------------
const EXT_ROLE_MAP: Record<string, FileRole> = {
  ".ts": "source", ".tsx": "source", ".js": "source", ".jsx": "source",
  ".py": "source", ".rs": "source", ".go": "source", ".c": "source",
  ".cpp": "source", ".cc": "source", ".cs": "source", ".java": "source",
  ".rb": "source", ".php": "source", ".swift": "source", ".kt": "source",
  ".sh": "source", ".bash": "source", ".zsh": "source",
  ".json": "config", ".yaml": "config", ".yml": "config",
  ".toml": "config", ".env": "config", ".ini": "config",
  ".md": "doc", ".txt": "doc", ".rst": "doc",
  ".sql": "schema", ".graphql": "schema", ".gql": "schema", ".proto": "schema",
  ".png": "asset", ".jpg": "asset", ".jpeg": "asset", ".svg": "asset",
  ".gif": "asset", ".webp": "asset", ".ico": "asset",
  ".woff": "asset", ".woff2": "asset", ".ttf": "asset",
  ".lock": "build", ".sum": "build",
};

const CONFIG_NAMES = new Set([
  "package.json", "tsconfig.json", "tsconfig.build.json", "pyproject.toml",
  "cargo.toml", "go.mod", "dockerfile", "docker-compose.yml",
  "docker-compose.yaml", ".env", ".env.example", ".gitignore",
  ".eslintrc", ".prettierrc", "jest.config.ts", "jest.config.js",
  "vite.config.ts", "webpack.config.js", "rollup.config.js",
  "makefile", "justfile",
]);

const ENTRY_NAMES = new Set([
  "index.ts", "index.js", "index.tsx", "index.jsx",
  "main.ts", "main.js", "main.py", "main.rs", "main.go",
  "app.ts", "app.js", "app.tsx", "app.jsx",
  "server.ts", "server.js",
]);

const GATEWAY_DIRS = new Set(["api", "routes", "handlers", "controllers", "endpoints"]);
const MODEL_DIRS   = new Set(["models", "types", "schema", "schemas", "interfaces", "entities"]);
const TEST_DIRS    = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const BUILD_DIRS   = new Set(["dist", "out", "build", ".next", ".nuxt", "node_modules", ".git"]);

export function inferRole(
  name: string,
  ext: string,
  isDir: boolean,
  parentDirName: string
): FileRole {
  if (isDir) return "dir";
  const nameLower = name.toLowerCase();
  if (CONFIG_NAMES.has(nameLower)) return "config";
  if (nameLower.includes(".test.") || nameLower.includes(".spec.")) return "test";
  if (parentDirName && TEST_DIRS.has(parentDirName.toLowerCase())) return "test";
  if (parentDirName && BUILD_DIRS.has(parentDirName.toLowerCase())) return "build";
  return EXT_ROLE_MAP[ext] ?? "unknown";
}

export function inferIntent(
  name: string,
  ext: string,
  role: FileRole,
  parentDirName: string,
  relPath: string
): FileIntent {
  if (role === "dir") return "unknown";
  if (role === "config") return "config";
  if (role === "doc") return "doc";
  if (role === "build") return "build";
  if (role === "test") return "test";
  if (role === "schema") return "model";
  const nameLower = name.toLowerCase();
  if (ENTRY_NAMES.has(nameLower)) return "entry";
  const parent = parentDirName.toLowerCase();
  if (GATEWAY_DIRS.has(parent)) return "gateway";
  if (MODEL_DIRS.has(parent)) return "model";
  return "module";
}

// Atom IDs are derived from rel_path so they survive project moves and
// can be shared across machines holding the same logical project.
export function buildAtomId(relPath: string): string {
  return crypto.createHash("sha256").update(relPath).digest("hex").slice(0, 16);
}

// Symbol IDs are derived from `<file_rel_path>#<scope_chain>` where scope_chain
// is e.g. "verifyToken" (top-level) or "Foo.bar" (method bar of class Foo).
export function buildSymbolId(fileRelPath: string, scopeChain: string): string {
  return buildAtomId(`${fileRelPath}#${scopeChain}`);
}

export function buildTetherId(projectRoot: string, timestamp: string): string {
  return crypto.createHash("sha256").update(`${projectRoot}|${timestamp}`).digest("hex").slice(0, 16);
}
