import * as fs from "fs";
import * as path from "path";
import { FSM, FSM_VERSION, SessionSnapshot } from "./fs-manifest";

// ---------------------------------------------------------------------------
// Persistence — FSM JSON dump/load + Session snapshot dump/load.
//
// Phase 4. The FSM cache lives at <projectRoot>/.spatial-tether/fsm.json by
// default; sessions sit alongside as session.json. The directory is hidden
// (dot-prefixed) so the walker's `include_hidden=false` default skips it.
//
// CACHE_VERSION is a wrapper-format integer that lets us invalidate stale
// caches without users having to delete files manually. Bump it whenever the
// on-disk shape changes (atom field added/removed, encoding changed, etc.).
// Distinct from FSM_VERSION — that semvers the in-memory FSM contract; this
// versions the wire format.
//   2 — post-Fix-1: atom.path and atom.meta.last_modified removed.
// ---------------------------------------------------------------------------
export const CACHE_VERSION = 2;

export interface SaveFSMResult {
  bytes: number;
}

export async function dumpFSM(fsm: FSM, filePath: string): Promise<SaveFSMResult> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  // Compact JSON (no pretty-printing) keeps file size small and load fast.
  // For human inspection, use `cat fsm.json | jq` — the cost of pretty-printing
  // by default would be paid on every save and never recouped.
  const wrapped = { version: CACHE_VERSION, ...fsm };
  const json = JSON.stringify(wrapped);
  await fs.promises.writeFile(filePath, json, "utf8");
  return { bytes: Buffer.byteLength(json, "utf8") };
}

export interface LoadFSMResult {
  fsm: FSM | null;
  reason?: "missing" | "version_mismatch" | "parse_error" | "io_error";
}

// Returns the FSM if successfully loaded AND the wrapper + FSM versions match.
// On any failure (file missing, malformed JSON, version drift), returns null
// with a reason — the gateway falls back to a full scan.
export async function loadFSM(filePath: string): Promise<LoadFSMResult> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return { fsm: null, reason: "missing" };
    return { fsm: null, reason: "io_error" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fsm: null, reason: "parse_error" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { fsm: null, reason: "version_mismatch" };
  }

  // Cache wrapper version — invalidates any cache written before CACHE_VERSION
  // existed (those have parsed.version === undefined) and any future bumps.
  if (parsed.version !== CACHE_VERSION) {
    process.stderr.write("[spatial-tether] cache version mismatch — rescanning\n");
    return { fsm: null, reason: "version_mismatch" };
  }

  if (parsed.fsm_version !== FSM_VERSION) {
    return { fsm: null, reason: "version_mismatch" };
  }

  return { fsm: parsed as FSM };
}

// ---------------------------------------------------------------------------
// Session snapshot persistence
// ---------------------------------------------------------------------------

export async function dumpSession(snapshot: SessionSnapshot, filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(snapshot), "utf8");
}

export async function loadSessionSnapshot(filePath: string): Promise<SessionSnapshot | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw) as SessionSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default cache locations
// ---------------------------------------------------------------------------

export const SPATIAL_TETHER_DIR = ".spatial-tether";
export const FSM_CACHE_FILE = "fsm.json";
export const SESSION_CACHE_FILE = "session.json";

export function defaultFSMPath(projectRoot: string): string {
  return path.join(projectRoot, SPATIAL_TETHER_DIR, FSM_CACHE_FILE);
}

export function defaultSessionPath(projectRoot: string): string {
  return path.join(projectRoot, SPATIAL_TETHER_DIR, SESSION_CACHE_FILE);
}
