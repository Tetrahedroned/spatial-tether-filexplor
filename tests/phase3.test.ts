import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { SpatialTetherFileExplorer } from "../src/gateway";
import { Session } from "../src/session";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");

describe("Phase 3: Stateful Session + Investigation Check", () => {
  let explorer: SpatialTetherFileExplorer;
  let session: Session;

  beforeEach(() => {
    explorer = new SpatialTetherFileExplorer(FIXTURE);
    explorer.scan();
    session = explorer.startSession();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Investigation Check decision tree
  // ────────────────────────────────────────────────────────────────────────

  describe("Investigation Check", () => {
    it("in-room request returns granted with outcome 'in_room'", () => {
      // src/auth.ts imports src/db.ts → db.ts is pulled into auth's Room via 'imports'
      session.enterRoom("src/auth.ts");
      const result = session.requestFile("src/db.ts");

      expect(result.granted).toBe(true);
      expect(result.outcome).toBe("in_room");
      expect(result.atom).not.toBeNull();
      expect(result.content).toContain("export async function query");
    });

    it("out-of-room request without justification: denied, logged", () => {
      // Focus on src/auth.ts at depth_limit=0 → atoms covers depth 2 only.
      // README.md is at depth 1 (root), not in window, not in import edges,
      // not an exit (different parent dir). Pure out-of-room target.
      session.enterRoom("src/auth.ts", 0);
      const result = session.requestFile("README.md");

      expect(result.granted).toBe(false);
      expect(result.outcome).toBe("denied");
      expect(result.content).toBeNull();

      // Logged with justification: undefined
      const log = session.investigation_log;
      expect(log).toHaveLength(1);
      expect(log[0].rel_path).toBe("README.md");
      expect(log[0].outcome).toBe("denied");
      expect(log[0].justification).toBeUndefined();
    });

    it("out-of-room request with justification: granted, in inventory, logged", () => {
      session.enterRoom("src/auth.ts", 0);
      const result = session.requestFile(
        "README.md",
        "checking the build log for errors"
      );

      expect(result.granted).toBe(true);
      expect(result.outcome).toBe("investigation_passed");
      expect(result.atom).not.toBeNull();

      // Now in inventory
      const invRelPaths = session.getInventory().map((a) => a.rel_path);
      expect(invRelPaths).toContain("README.md");

      // Log preserves the justification string
      const last = session.investigation_log.at(-1)!;
      expect(last.outcome).toBe("investigation_passed");
      expect(last.justification).toBe("checking the build log for errors");
    });

    it("subsequent request for inventoried file: outcome 'in_inventory'", () => {
      session.enterRoom("src/auth.ts", 0);
      session.requestFile("README.md", "first read");
      const second = session.requestFile("README.md");

      expect(second.granted).toBe(true);
      expect(second.outcome).toBe("in_inventory");
      // Second request does not require justification
    });

    it("exit request: granted, added to inventory", () => {
      // Focus on src/ directory with depth_limit=0 → atoms only contains src/
      // itself. Children of src/ (auth.ts, db.ts, main.ts, ...) are exits-only.
      session.enterRoom("src", 0);
      const result = session.requestFile("src/main.ts");

      expect(result.granted).toBe(true);
      expect(result.outcome).toBe("exit");

      // Added to inventory after the exit grant
      const invRelPaths = session.getInventory().map((a) => a.rel_path);
      expect(invRelPaths).toContain("src/main.ts");
    });

    it("non-existent path: denied", () => {
      session.enterRoom("src/auth.ts");
      const result = session.requestFile("does/not/exist.ts");

      expect(result.granted).toBe(false);
      expect(result.outcome).toBe("denied");
      expect(result.atom).toBeNull();
    });

    it("symbol path is not a file: denied", () => {
      // Symbols (e.g. "src/auth.ts#verifyToken") are not file atoms.
      // requestFile should reject them.
      session.enterRoom("src/auth.ts");
      const result = session.requestFile("src/auth.ts#verifyToken");

      expect(result.granted).toBe(false);
      expect(result.outcome).toBe("denied");
    });

    it("empty justification string is treated as missing", () => {
      session.enterRoom("src/auth.ts", 0);
      const result = session.requestFile("README.md", "   ");
      expect(result.granted).toBe(false);
      expect(result.outcome).toBe("denied");
    });

    it("out-of-room: log[0].rel_path matches the requested path", () => {
      session.enterRoom("src/auth.ts", 0);
      session.requestFile("README.md");
      expect(session.investigation_log[0].rel_path).toBe("README.md");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Session-modified detection
  // ────────────────────────────────────────────────────────────────────────

  describe("session-modified detection", () => {
    it("explicit markModified flags the file", () => {
      session.markModified("src/auth.ts");
      const fsm = explorer.getManifest();
      const auth = fsm.atoms.find((a) => a.rel_path === "src/auth.ts")!;
      expect(session.session_modified.has(auth.id)).toBe(true);
    });

    it("writes after started_at are reflected in session_modified after refresh", () => {
      const target = path.join(FIXTURE, "src/auth.ts");
      const future = new Date(Date.now() + 60_000);   // 1 minute ahead
      fs.utimesSync(target, future, future);

      // refresh() auto-runs session.detectModifications when a session is
      // attached (per blueprint), so the modification surfaces in
      // session_modified without an explicit detect call.
      explorer.refresh();

      const fsm  = explorer.getManifest();
      const auth = fsm.atoms.find((a) => a.rel_path === "src/auth.ts")!;
      expect(session.session_modified.has(auth.id)).toBe(true);

      // Reset mtime so the change doesn't leak into other tests
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(target, past, past);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Session-relative gravity
  // ────────────────────────────────────────────────────────────────────────

  describe("gravity bonuses", () => {
    it("inventory bonus increases gravity for inventoried atoms", () => {
      // Sessionless baseline — never bonused
      const sessionless = new SpatialTetherFileExplorer(FIXTURE);
      sessionless.scan();
      const baseGravity = sessionless
        .getRoom("src/auth.ts")
        .atoms.find((a) => a.rel_path === "src/feature.ts")!.gravity;

      // Force feature.ts into inventory via the exit path:
      //   focus on src/ at depth_limit=0 → atoms = {src dir}, children are
      //   exits-only.
      session.enterRoom("src", 0);
      const exitResult = session.requestFile("src/feature.ts");
      expect(exitResult.outcome).toBe("exit");
      expect(session.inventory.has(exitResult.atom!.id)).toBe(true);

      // Re-enter auth.ts at default depth and observe feature.ts's gravity
      const room = session.enterRoom("src/auth.ts");
      const featureInRoom = room.atoms.find((a) => a.rel_path === "src/feature.ts")!;
      expect(featureInRoom.gravity).toBeGreaterThan(baseGravity);
      // +0.15 inventory bonus, capped at 1.0
      expect(featureInRoom.gravity).toBeCloseTo(
        Math.min(1.0, Math.round((baseGravity + 0.15) * 100) / 100),
        2
      );
    });

    it("session_modified bonus increases gravity", () => {
      // Mark a file modified, then read its gravity from the room
      session.markModified("src/db.ts");

      const baseline = explorer.getRoom("src/auth.ts").atoms.find(
        (a) => a.rel_path === "src/db.ts"
      )!;
      // baseline above is computed without a session attached (getRoom routes
      // through the session, but session has no inventory/recently here for db
      // beyond session_modified)
      // Re-derive from session-aware path explicitly:
      const room = session.enterRoom("src/auth.ts");
      const db = room.atoms.find((a) => a.rel_path === "src/db.ts")!;

      // The baseline above is *also* session-aware (gateway.getRoom routes
      // through session), so both should match. But session_modified bonus
      // applies in both. Compare against a sessionless gateway.
      const sessionless = new SpatialTetherFileExplorer(FIXTURE);
      sessionless.scan();
      const dbBare = sessionless
        .getRoom("src/auth.ts")
        .atoms.find((a) => a.rel_path === "src/db.ts")!;

      expect(db.gravity).toBeGreaterThan(dbBare.gravity);
      expect(db.gravity).toBeCloseTo(
        Math.min(1.0, Math.round((dbBare.gravity + 0.20) * 100) / 100),
        2
      );
      // baseline isn't asserted directly; just keep the variable used
      void baseline;
    });

    it("FSM atoms are NOT mutated by session bonuses", () => {
      session.markModified("src/db.ts");
      const room = session.enterRoom("src/auth.ts");
      const dbInRoom = room.atoms.find((a) => a.rel_path === "src/db.ts")!;

      const fsm = explorer.getManifest();
      const dbInFSM = fsm.atoms.find((a) => a.rel_path === "src/db.ts")!;

      expect(dbInRoom.gravity).not.toBe(dbInFSM.gravity);
      // FSM atom's gravity is the static project-relative value
      expect(dbInFSM.gravity).toBeLessThan(dbInRoom.gravity);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // History
  // ────────────────────────────────────────────────────────────────────────

  describe("history", () => {
    it("history append on each enterRoom; left_at set on next enter", () => {
      session.enterRoom("src/auth.ts");
      session.enterRoom("src/db.ts");
      session.enterRoom("src/main.ts");

      const h = session.getHistory();
      expect(h).toHaveLength(3);
      expect(h.map((v) => v.focus_path)).toEqual([
        "src/auth.ts",
        "src/db.ts",
        "src/main.ts",
      ]);

      // Earlier visits have left_at set; the current (last) does not
      expect(h[0].left_at).not.toBeNull();
      expect(h[1].left_at).not.toBeNull();
      expect(h[2].left_at).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Serialize / restore
  // ────────────────────────────────────────────────────────────────────────

  describe("serialize → restore", () => {
    it("round-trips state", () => {
      session.enterRoom("src/auth.ts", 0);
      session.requestFile("README.md", "first read");
      session.requestFile("does/not/exist.ts");   // denied
      session.markModified("src/db.ts");
      session.enterRoom("src/main.ts");

      const snap = session.serialize();
      const restored = Session.restore(snap, explorer);

      expect(restored.started_at).toBe(session.started_at);
      expect(restored.current_room).toBe(session.current_room);
      expect(restored.history.length).toBe(session.history.length);
      expect(Array.from(restored.inventory).sort()).toEqual(
        Array.from(session.inventory).sort()
      );
      expect(Array.from(restored.session_modified).sort()).toEqual(
        Array.from(session.session_modified).sort()
      );
      expect(restored.investigation_log.length).toBe(session.investigation_log.length);
      expect(restored.investigation_log[0].outcome).toBe("investigation_passed");
      expect(restored.investigation_log[0].justification).toBe("first read");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Gateway integration
  // ────────────────────────────────────────────────────────────────────────

  describe("gateway integration", () => {
    it("currentSession returns the attached session", () => {
      expect(explorer.currentSession()).toBe(session);
    });

    it("describeRoom shows session start time and INVENTORY/MODIFIED flags", () => {
      // Add src/feature.ts to inventory via the exit path so it appears with
      // [INVENTORY] when we re-enter the auth Room (where feature.ts is in
      // depth_window).
      session.enterRoom("src", 0);
      session.requestFile("src/feature.ts");

      session.markModified("src/db.ts");

      const text = explorer.describeRoom("src/auth.ts");
      expect(text).toMatch(/Session started:/);
      // db.ts: imports + session_modified
      expect(text).toMatch(/MODIFIED/);
      // feature.ts: depth_window + inventory
      expect(text).toMatch(/INVENTORY/);
      // Investigation log preview surfaces the exit grant
      expect(text).toMatch(/RECENT INVESTIGATION CHECKS/);
    });

    it("endSession returns a snapshot and detaches", () => {
      session.enterRoom("src/auth.ts");
      const snap = explorer.endSession();
      expect(snap).not.toBeNull();
      expect(snap!.current_room).toBe("src/auth.ts");
      expect(explorer.currentSession()).toBeNull();
    });
  });
});
