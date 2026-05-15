# spatial-tether-filexplor

A code-aware indexer that remembers where you are in a codebase.

Code has shape. When you open a project you haven't touched in three months, your eye finds the entry file before you've read a line of it. You know which folder holds the tests without looking. You can feel which function sits near another in your head, even though they live on different pages of source. That sense of position is how programmers navigate, and it's most of what gets lost the moment you hand the keys to an LLM.

This program builds a map of a codebase and serves it to anyone who asks. The map records where every file sits, what it imports, what imports it, what functions live inside, who calls those functions, and who calls back. It assigns each thing a number called gravity that says how central it is to the rest. You ask the map questions and get answers in milliseconds.

The original target was AI coding agents. Without help, they navigate a codebase blind — pour every file into a prompt and hope, or stumble around opening things at random. Given the map, an agent can ask what's near its current focus, what something connects to, what looks important. Real questions with real answers, cheap to compute once the indexing's done.

---

## getting started

Install and build:

```bash
npm install
npm run build:server
```

Run it as an MCP server:

```bash
node dist/mcp-server.js /path/to/your/project
```

Or as an HTTP and WebSocket server, default port 3000, bound to localhost:

```bash
node dist/http-server.js /path/to/your/project --port 3000
```

Or call it from Node:

```typescript
import { SpatialTetherFileExplorer } from "./src/gateway";

const explorer = new SpatialTetherFileExplorer("/path/to/project");
await explorer.load();

const room    = explorer.getRoom("src/main.ts", 2);
const callers = explorer.findCallers("src/auth.ts#verifyToken");
const link    = explorer.getRelationship("src/main.ts", "src/auth.ts");
```

The cache lives at `<project>/.spatial-tether/fsm.json` and updates incrementally when files change. It versions itself, so upgrading the binary doesn't require manual cleanup.

---

## what it parses

| Language | Extensions |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |

For those languages it pulls every top-level declaration: functions, classes, methods, constants, variables, types, interfaces, enums. Each gets a line range, a scope chain, and an exported flag. For the TypeScript family it also wires up the call graph, so you can ask who calls a function and who that function calls.

Files in other languages still get atoms with role, intent, depth, and gravity. Markdown, JSON, YAML, TOML, configs, schemas, assets are all recognized. They carry signal even without symbol-level data.

The walker skips a default set of build and dependency directories — `node_modules`, `.git`, `.svn`, `dist`, `out`, `build`, `.next`, `.nuxt`, `.turbo`, `.vercel`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `target`, `.cargo`, `vendor`, `.venv`, `venv`, `env`, `.tox`, `coverage`, `.nyc_output`, `.cache` — and anything matched by the project's `.gitignore`.

---

## the manifest

The full manifest is called the FSM (Filesystem Spatial Manifest). Every node in it is an atom. There are four kinds: `dir`, `file`, `symbol`, `method`. Each atom carries:

| Field | What it holds |
|---|---|
| `id` | 16-character hash of the relative path, stable across machines |
| `kind` | dir, file, symbol, method |
| `name` | basename or symbol name |
| `rel_path` | path relative to project root; symbols use `file.ts#scope.chain` |
| `geom` | `{ x, y, w, h }` — depth, sibling index, normalized weight, line height |
| `gravity` | centrality score from 0 to 1 |
| `parent_id` | the directory containing this file, or file containing this symbol |
| `siblings_total` | total peers at this depth, useful for normalizing layouts |
| `import_refs` | IDs of atoms this file imports |
| `contains_refs` | IDs of children this atom contains |
| `references` | IDs of symbols this symbol calls |
| `referenced_by` | IDs of symbols that call this one |
| `temporal_score` | normalized recency, 0–1 across the project |
| `mtime_ms` | file modification time |
| `meta.role` | source, test, config, doc, schema, asset, build, dir, unknown |
| `meta.intent` | entry, module, gateway, model, test, config, doc, build, unknown |
| `meta.is_entry` | true if this file is a declared package entry point |

Symbols carry extra fields: `symbol_kind`, a `span` with start and end lines, and an `exported` boolean.

### gravity

Gravity is the number that tells the manifest what matters. It starts from a base per role and accumulates modifiers.

| Role | Base |
|---|---|
| source | 0.70 |
| schema | 0.65 |
| config | 0.50 |
| test | 0.40 |
| doc | 0.30 |
| dir | 0.20 |
| unknown | 0.10 |
| build | 0.05 |
| asset | 0.05 |

On top of that:

- Intent bonus: `entry` adds 0.25, `gateway` adds 0.15, `model` adds 0.10
- Depth penalty: 0.04 per directory level, capped at 0.30
- In-degree bonus: up to 0.20, scaled by how many files import this one
- Recency bonus: up to 0.10, scaled by modification time within the project's range

All weights are tunable per project. The point isn't exact values; ranking is computed once and cheap to query forever.

### rooms

A Room is the bounded view returned for a focus path. It contains the focus atom itself, every file the focus imports, every file that imports it, every symbol the focus defines, and a depth-window of nearby files. The total is capped at 150 atoms so the response stays bounded on huge codebases. Direct connections are always kept regardless of gravity. The cap trims peripheral context only.

```
=== ROOM: src/fs-engine.ts ===
Breadcrumb: src > src/fs-engine.ts
Depth window: ±2 levels from focus

DIRECTORIES:
  [d:0] ./
  [d:1] src/

FILES:
  [d:1 g:1.00] src/fs-engine.ts  (focus)
  [d:1 g:0.87] src/fs-walker.ts
  [d:1 g:0.85] src/gateway.ts
  [d:1 g:0.66] src/persist.ts

SYMBOLS (defined in focus):
  function buildFSM (lines 97-465) [exported]
  function buildRoom (lines 575-735) [exported]

EXITS:
  fs-manifest.ts
  fs-symbols.ts
  watcher.ts
```

### sessions and the Investigation Check

A Session tracks one caller's path through the project: the current Room, every Room visited, every file pulled into the caller's inventory, every file modified during the session, and a log of every file request. File access through the session is gated. If the file is in the current Room or already in the inventory, it's free. If it's outside, the caller must supply a non-empty justification — every request, granted or denied, is logged. The point is to give an agent a structured prompt to think about *why* it needs a file before reading it, and to leave a record of what it asked for.

---

## numbers

Measured against vite's repository, around 2,500 source files, on a single thread:

| Operation | Time |
|---|---|
| Cold scan, full parse | 6.3 s |
| Warm load from cache | 80 ms |
| Symbol lookup by name | 2 ms |
| Find callers of a function | 0.05 ms |
| Get relationship between two files | 2 ms |
| Heap during scan | 30 MB |
| Cache file on disk | 3.7 MB |

Cold scan is the only expensive operation. After that, the indexer holds the manifest in memory and queries are constant-time map lookups.

---

## ways to use it

The indexer is the spine. Three things wrap it.

### MCP server

```bash
node dist/mcp-server.js /path/to/your/project
```

Speaks JSON-RPC over stdio. The tools registered: `scan`, `summarize`, `refresh`, `full_scan`, `get_atom`, `find_file`, `find_symbol`, `get_symbol`, `find_callers`, `find_callees`, `get_relationship`, `get_room`, `describe_room`, `start_session`, `end_session`, `current_session`, `enter_room`, `request_file`, `get_inventory`, `get_history`, `save_fsm`, `load_fsm`, `save_session`, `load_session`, `watch`, `unwatch`. Any MCP-compatible client can connect.

### HTTP and WebSocket server

```bash
node dist/http-server.js /path/to/your/project --port 3000
```

REST endpoints under `/api`: `fsm`, `room`, `atom`, `file` (GET and POST), `session`, `enter_room`, `request_file`, `agent_focus`, `demo_step`, `reset_session`, `git`. The WebSocket on `/ws` broadcasts `init`, `update`, `room_change`, `investigation`, and `session_reset` events as the project changes. Anything that speaks HTTP can talk to it.

This is a localhost dev tool. The server binds to `127.0.0.1` by default and has no auth. It exposes file read/write and a `git commit` endpoint, so only pass `--host 0.0.0.0` on a trusted network you control.

### In-process Node API

```typescript
import { SpatialTetherFileExplorer } from "./src/gateway";

const explorer = new SpatialTetherFileExplorer("/path/to/project");
await explorer.load();

explorer.getRoom("src/main.ts", 2);
explorer.findCallers("src/auth.ts#verifyToken");
explorer.getRelationship("src/main.ts", "src/auth.ts");
```

The `SpatialTetherFileExplorer` class in `src/gateway.ts` is the public surface. Public methods: `scan`, `fullScan`, `getManifest`, `getAtom`, `getRoom`, `describeRoom`, `findFile`, `findSymbol`, `getSymbol`, `findCallers`, `findCallees`, `getRelationship`, `summarize`, `refresh`, `save`, `load`, `startSession`, `endSession`, `currentSession`, `attachSession`, `saveSession`, `loadSession`, `watch`, `unwatch`, `getProjectRoot`.

### scan script

```bash
npm run scan /path/to/project [focus_path]
```

Prints a project summary to stdout. With an optional focus path, also prints a Room description for that file. This runs `src/gateway.ts` directly via ts-node and exits.

---

## what's inside

```
src/
├── fs-manifest.ts        atom and FSM type definitions
├── fs-walker.ts          .gitignore-aware filesystem traversal
├── fs-imports.ts         tsconfig.paths and relative + alias resolution
├── fs-entry.ts           package.json-driven entry-point detection
├── fs-symbols.ts         language dispatcher
├── fs-symbols-types.ts   shared types for the symbol walkers
├── fs-symbols-ts.ts      tree-sitter for TS, TSX, JS, JSX, MJS, CJS
├── fs-symbols-python.ts  tree-sitter for Python
├── fs-symbols-go.ts      tree-sitter for Go
├── fs-symbols-rust.ts    tree-sitter for Rust
├── fs-engine.ts          builds the FSM, generates Rooms
├── persist.ts            versioned cache, dump and load
├── watcher.ts            chokidar wrapper for incremental refresh
├── session.ts            per-caller navigation state
├── gateway.ts            the public class everything connects through
├── mcp-server.ts         stdio MCP transport
└── http-server.ts        HTTP + WS transport
```

The `fixtures/` directory has small projects in each supported language, used by the test suite.

---

## what it isn't

Honest limits. Every tool should know what it isn't.

It doesn't read source. The atoms know names and shapes, not what the code actually does. To know what a function does you still have to open the file.

It doesn't resolve types. The call graph is built from imports and name binding. Method dispatch through interfaces, generics, and inheritance hierarchies stays unresolved.

It parses five languages. Adding a language means writing a tree-sitter walker for it. Other languages still produce a manifest, just without symbol-level data.

It indexes one project at a time. Monorepos work if you point it at the root. There's no global graph across multiple checkouts.

It doesn't replace your editor's go-to-definition. It answers a different class of question, the whole-codebase ones an editor doesn't see because the editor only sees files you've opened.

---

## tests

```bash
npm test
```

141 tests across twelve files. The suite covers symbol extraction in all five languages, call graph construction, gravity computation, room construction with cap edge cases, persistence and cache versioning, the watcher, the HTTP and MCP transports, and session management.

---

## license

MIT. See [LICENSE](./LICENSE). Built by Tetrahedroned.
