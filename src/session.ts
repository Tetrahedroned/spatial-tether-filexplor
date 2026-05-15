import * as fs from "fs";
import * as path from "path";
import {
  FSM,
  FSMAtom,
  FSMRoom,
  RoomVisit,
  InvestigationResult,
  InvestigationOutcome,
  InvestigationLogEntry,
  SessionSnapshot,
} from "./fs-manifest";
import { buildRoom } from "./fs-engine";

// ---------------------------------------------------------------------------
// Session — Phase 3
//
// Tracks the agent's path through the project: which Room it's in, what
// Rooms it has visited, what files are in its inventory (paid the
// Investigation Check cost), what files it has modified this session, and a
// log of every Investigation Check outcome.
//
// The Investigation Check is the README's central promise: file access is
// gated by Room membership and inventory. Out-of-Room access requires a
// non-empty justification, and every request — granted or denied — is
// logged.
// ---------------------------------------------------------------------------

// Subset of gateway state Session needs. We avoid a circular import by
// declaring this shape rather than importing SpatialTetherFileExplorer.
export interface SessionGateway {
  getManifest(): FSM;
  // resolve a relative path to an atom (or null). If the gateway is not
  // session-aware it should call its own getAtom.
  getAtom(relPath: string): FSMAtom | null;
  // Project root, needed to reconstruct atom abs paths since FSMAtom.path
  // was removed in favor of the canonical rel_path.
  getProjectRoot(): string;
}

export class Session {
  readonly started_at: string;
  current_room: string | null = null;
  // Depth limit used for the current room — needed so requestFile recomputes
  // the same room view the agent saw at enterRoom time (otherwise the "exit"
  // outcome would be unreachable for any focus that was entered with a
  // non-default depth).
  current_depth_limit: number | null = null;
  history: RoomVisit[] = [];
  inventory = new Set<string>();
  session_modified = new Set<string>();
  investigation_log: InvestigationLogEntry[] = [];

  constructor(
    private gateway: SessionGateway,
    started_at: string = new Date().toISOString(),
  ) {
    this.started_at = started_at;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  // Enter a new Room. Closes the current visit (if any) and pushes a new one.
  // Returns the freshly-built Room (session-aware gravity bonuses applied).
  enterRoom(focus_path: string, depth_limit?: number): FSMRoom {
    const now = new Date().toISOString();
    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      if (last.left_at === null) last.left_at = now;
    }
    this.history.push({ focus_path, entered_at: now, left_at: null });
    this.current_room = focus_path;
    this.current_depth_limit = depth_limit ?? null;
    return buildRoom(this.gateway.getManifest(), focus_path, depth_limit, this);
  }

  getCurrentRoom(depth_limit?: number): FSMRoom | null {
    if (this.current_room === null) return null;
    const dl = depth_limit ?? this.current_depth_limit ?? undefined;
    return buildRoom(this.gateway.getManifest(), this.current_room, dl, this);
  }

  getHistory(): RoomVisit[] {
    return this.history.slice();
  }

  // Wipe navigation history. Keeps current_room (the agent stays where it is)
  // and inventory/investigation_log/session_modified — those are accumulated
  // privileges/audit, not navigation. If a current_room exists we re-push a
  // fresh visit so subsequent enterRoom calls have a non-degenerate history.
  // Used by the UI's "↺ RESET" button to clear a stuck trail.
  clearHistory(): void {
    this.history = [];
    if (this.current_room !== null) {
      this.history.push({
        focus_path: this.current_room,
        entered_at: new Date().toISOString(),
        left_at:    null,
      });
    }
  }

  // Returns the last 5 distinct focus_paths visited (current included).
  // Used by the gravity formula to grant a recently-visited bonus.
  recentFocusPaths(): Set<string> {
    const paths = new Set<string>();
    for (let i = this.history.length - 1; i >= 0 && paths.size < 5; i--) {
      paths.add(this.history[i].focus_path);
    }
    return paths;
  }

  // -------------------------------------------------------------------------
  // Investigation Check
  // -------------------------------------------------------------------------

  requestFile(rel_path: string, justification?: string): InvestigationResult {
    const at = new Date().toISOString();

    // Step 1: resolve. Investigation Check operates on file atoms only.
    const atom = this.gateway.getAtom(rel_path);
    if (!atom || atom.kind !== "file") {
      return this.deny(rel_path, at, "denied", null, justification);
    }

    // Step 2: already in inventory — already paid the cost.
    if (this.inventory.has(atom.id)) {
      return this.grant(atom, "in_inventory", at, justification);
    }

    // Steps 3 & 4 require a current Room. Use the depth_limit the agent
    // entered with so the Room matches what the agent was shown.
    if (this.current_room !== null) {
      const room = buildRoom(
        this.gateway.getManifest(),
        this.current_room,
        this.current_depth_limit ?? undefined,
        this,
      );

      // Step 3: in current Room.
      if (room.atoms.some((a) => a.id === atom.id)) {
        return this.grant(atom, "in_room", at, justification);
      }

      // Step 4: in current Room's exits.
      if (room.exits.some((a) => a.id === atom.id)) {
        this.inventory.add(atom.id);
        return this.grant(atom, "exit", at, justification);
      }
    }

    // Step 5: outside Room. Require a non-empty justification.
    const j = (justification ?? "").trim();
    if (j === "") {
      return this.deny(rel_path, at, "denied", atom, undefined);
    }

    this.inventory.add(atom.id);
    return this.grant(atom, "investigation_passed", at, j);
  }

  private grant(
    atom: FSMAtom,
    outcome: InvestigationOutcome,
    at: string,
    justification?: string,
  ): InvestigationResult {
    let content: string | null = null;
    try {
      const abs = path.join(this.gateway.getProjectRoot(), atom.rel_path);
      content = fs.readFileSync(abs, "utf8");
    } catch {
      // Leave content null; the grant still stands. The agent sees a granted
      // result with content === null and can decide what to do.
    }
    this.investigation_log.push({
      rel_path: atom.rel_path,
      outcome,
      justification,
      at,
    });
    return { granted: true, outcome, atom, content, justification };
  }

  private deny(
    rel_path: string,
    at: string,
    outcome: InvestigationOutcome,
    atom: FSMAtom | null,
    justification?: string,
  ): InvestigationResult {
    this.investigation_log.push({
      rel_path,
      outcome,
      justification,
      at,
    });
    return { granted: false, outcome, atom, content: null, justification };
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  getInventory(): FSMAtom[] {
    const fsm = this.gateway.getManifest();
    return fsm.atoms.filter((a) => this.inventory.has(a.id));
  }

  // -------------------------------------------------------------------------
  // Session-modified detection
  // -------------------------------------------------------------------------

  // Manually mark a file as modified this session (e.g. after an external
  // tool writes it).
  markModified(rel_path: string): void {
    const atom = this.gateway.getAtom(rel_path);
    if (atom && atom.kind === "file") {
      this.session_modified.add(atom.id);
    }
  }

  // Compare each atom's mtime to session.started_at. Any atom modified since
  // the session began is added to session_modified. Returns the IDs newly
  // added on this call (for change-event emission).
  detectModifications(): string[] {
    const startedMs = new Date(this.started_at).getTime();
    const fsm = this.gateway.getManifest();
    const newlyModified: string[] = [];
    for (const a of fsm.atoms) {
      if (a.kind !== "file") continue;
      if (this.session_modified.has(a.id)) continue;
      const m = a.mtime_ms;
      if (m > 0 && m >= startedMs) {
        this.session_modified.add(a.id);
        newlyModified.push(a.id);
      }
    }
    return newlyModified;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  serialize(): SessionSnapshot {
    return {
      started_at:        this.started_at,
      current_room:      this.current_room,
      history:           this.history.map((v) => ({ ...v })),
      inventory:         Array.from(this.inventory),
      session_modified:  Array.from(this.session_modified),
      investigation_log: this.investigation_log.map((e) => ({ ...e })),
    };
  }

  static restore(snap: SessionSnapshot, gateway: SessionGateway): Session {
    const s = new Session(gateway, snap.started_at);
    s.current_room       = snap.current_room;
    s.history            = snap.history.map((v) => ({ ...v }));
    s.inventory          = new Set(snap.inventory);
    s.session_modified   = new Set(snap.session_modified);
    s.investigation_log  = snap.investigation_log.map((e) => ({ ...e }));
    return s;
  }
}

