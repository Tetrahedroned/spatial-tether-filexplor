import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { performance } from "perf_hooks";

import { SpatialTetherFileExplorer } from "../src/gateway";
import { FSM_VERSION } from "../src/fs-manifest";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIXTURE      = path.join(PROJECT_ROOT, "fixtures", "ts-app");

// Each test runs against an isolated temp cache file so they don't collide.
function tmpFSMPath(): string {
  return path.join(
    PROJECT_ROOT, ".spatial-tether",
    `test-fsm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}
function tmpSessionPath(): string {
  return path.join(
    PROJECT_ROOT, ".spatial-tether",
    `test-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

// Tiny atom comparator that ignores fields whose differences are expected
// across save/load (none for now — but kept in case persistence drifts).
function expectAtomsEqual(a: any, b: any): void {
  expect(a.id).toBe(b.id);
  expect(a.kind).toBe(b.kind);
  expect(a.rel_path).toBe(b.rel_path);
  expect(a.gravity).toBe(b.gravity);
  expect(a.import_refs.sort()).toEqual(b.import_refs.sort());
  expect(a.contains_refs.sort()).toEqual(b.contains_refs.sort());
  expect(a.mtime_ms).toBe(b.mtime_ms);
  expect(a.symbol_kind).toBe(b.symbol_kind);
}

describe("Phase 4: persistence + incremental refresh + watcher", () => {
  // ────────────────────────────────────────────────────────────────────────
  // FSM dump / load round-trip
  // ────────────────────────────────────────────────────────────────────────

  describe("FSM JSON dump/load", () => {
    it("dumpFSM → loadFSM round-trips equal atoms", async () => {
      const explorerA = new SpatialTetherFileExplorer(FIXTURE);
      explorerA.scan();
      const fsmA = explorerA.getManifest();

      const cachePath = tmpFSMPath();
      try {
        await explorerA.save(cachePath);
        expect(fs.existsSync(cachePath)).toBe(true);

        const explorerB = new SpatialTetherFileExplorer(FIXTURE);
        const result = await explorerB.load(cachePath);
        expect(result.loaded).toBe(true);

        const fsmB = explorerB.getManifest();
        expect(fsmB.fsm_version).toBe(FSM_VERSION);
        expect(fsmB.atoms.length).toBe(fsmA.atoms.length);
        expect(fsmB.tether_id).toBe(fsmA.tether_id);

        // Compare each atom by ID
        const byIdA = new Map(fsmA.atoms.map((a) => [a.id, a]));
        const byIdB = new Map(fsmB.atoms.map((a) => [a.id, a]));
        for (const [id, atomA] of byIdA) {
          const atomB = byIdB.get(id);
          expect(atomB).toBeDefined();
          expectAtomsEqual(atomA, atomB);
        }
      } finally {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      }
    });

    it("loadFSM completes in <100ms on this project", async () => {
      // Exclude dungeon-benchmark/ — it's a multi-tier corpus added later
      // (chalk + fastify + vite mirrors) that triples the FSM size and is not
      // representative of "this project's" core src/. Without the skip, the
      // perf budget tracks dungeon-benchmark's growth instead of src/.
      const skipOpts = { skip_dirs: ["dungeon-benchmark"] };
      const explorerA = new SpatialTetherFileExplorer(PROJECT_ROOT, skipOpts);
      explorerA.scan();
      const cachePath = tmpFSMPath();
      try {
        await explorerA.save(cachePath);

        const explorerB = new SpatialTetherFileExplorer(PROJECT_ROOT, skipOpts);
        const t0 = performance.now();
        const result = await explorerB.load(cachePath);
        const elapsedMs = performance.now() - t0;

        expect(result.loaded).toBe(true);
        // Budget per blueprint: cold load with FSM cache hit < 100ms
        expect(elapsedMs).toBeLessThan(100);

        const atomCount = explorerB.getManifest().atoms.length;
        expect(atomCount).toBeGreaterThan(0);
      } finally {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      }
    });

    it("version mismatch falls back to full scan", async () => {
      const cachePath = tmpFSMPath();
      try {
        // Write a malformed (bad-version) FSM file
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(
          cachePath,
          JSON.stringify({ fsm_version: "0.0.0", atoms: [] }),
        );

        const explorer = new SpatialTetherFileExplorer(FIXTURE);
        const result = await explorer.load(cachePath);
        expect(result.loaded).toBe(false);
        expect(result.reason).toBe("version_mismatch");
        expect(result.fellback_to_scan).toBe(true);

        // FSM is valid (full scan happened)
        const fsm = explorer.getManifest();
        expect(fsm.atoms.length).toBeGreaterThan(0);
        expect(fsm.fsm_version).toBe(FSM_VERSION);
      } finally {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      }
    });

    it("missing file falls back to full scan", async () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      const result = await explorer.load("/nonexistent/path/fsm.json");
      expect(result.loaded).toBe(false);
      expect(result.reason).toBe("missing");
      expect(result.fellback_to_scan).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Incremental refresh diff
  // ────────────────────────────────────────────────────────────────────────

  describe("incremental refresh", () => {
    it("write to one fixture file → only that file appears in updated[]", () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();

      const target = path.join(FIXTURE, "src/auth.ts");
      const future = new Date(Date.now() + 60_000);
      try {
        fs.utimesSync(target, future, future);

        const diff = explorer.refresh();

        const fsm = explorer.getManifest();
        const auth = fsm.atoms.find((a) => a.rel_path === "src/auth.ts")!;

        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.updated).toEqual([auth.id]);
      } finally {
        // Restore mtime
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(target, past, past);
      }
    });

    it("untouched scan returns no diff", () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();
      const diff = explorer.refresh();
      expect(diff.added).toEqual([]);
      expect(diff.updated).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("new file is reported as added; deleting it is reported as removed", () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();

      const newFile = path.join(FIXTURE, "src/_phase4_tmp.ts");
      try {
        fs.writeFileSync(newFile, "export const ephemeral = 42;\n");
        const addedDiff = explorer.refresh();

        const newAtom = explorer
          .getManifest()
          .atoms.find((a) => a.rel_path === "src/_phase4_tmp.ts");
        expect(newAtom).toBeDefined();
        expect(addedDiff.added).toContain(newAtom!.id);
        expect(addedDiff.updated).toEqual([]);

        // Now delete it
        fs.unlinkSync(newFile);
        const removedDiff = explorer.refresh();
        expect(removedDiff.removed).toContain(newAtom!.id);
        expect(removedDiff.added).toEqual([]);
      } finally {
        if (fs.existsSync(newFile)) fs.unlinkSync(newFile);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // chokidar watcher
  // ────────────────────────────────────────────────────────────────────────

  describe("chokidar watcher", () => {
    it("fires update event within 500ms of fs.writeFileSync", async () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();

      const watcher = explorer.watch();
      const target = path.join(FIXTURE, "src/_phase4_watcher_tmp.ts");

      try {
        const eventPromise = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("watcher did not fire within 500ms")),
            500,
          );
          explorer.events.once("update", (event) => {
            clearTimeout(timer);
            resolve(event);
          });
        });

        // Give chokidar a tick to actually attach listeners
        await new Promise((r) => setTimeout(r, 50));

        fs.writeFileSync(target, "export const watched = 1;\n");

        const event = await eventPromise;
        expect(event.changed_atoms).toBeInstanceOf(Array);
        expect(event.changed_atoms.length).toBeGreaterThan(0);
        expect(event.timestamp).toBeInstanceOf(Date);
      } finally {
        await watcher.stop();
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    }, 5_000);

    it("unwatch stops the watcher", async () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();
      explorer.watch();
      await explorer.unwatch();
      // No assertion on absence — just verify it doesn't throw
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Session snapshot persistence
  // ────────────────────────────────────────────────────────────────────────

  describe("session save/load", () => {
    it("dumpSession → loadSession round-trips inventory and investigation_log", async () => {
      const explorer = new SpatialTetherFileExplorer(FIXTURE);
      explorer.scan();
      const session = explorer.startSession();

      session.enterRoom("src/auth.ts", 0);
      session.requestFile("README.md", "checking project README");
      session.requestFile("does/not/exist.ts");           // denied
      session.markModified("src/db.ts");
      session.enterRoom("src/main.ts");

      const cachePath = tmpSessionPath();
      try {
        await explorer.saveSession(cachePath);
        expect(fs.existsSync(cachePath)).toBe(true);

        // Detach and reload
        explorer.endSession();
        const loadResult = await explorer.loadSession(cachePath);
        expect(loadResult.loaded).toBe(true);

        const restored = explorer.currentSession();
        expect(restored).not.toBeNull();
        expect(restored!.started_at).toBe(session.started_at);
        expect(restored!.current_room).toBe("src/main.ts");
        expect(restored!.history.length).toBe(2);

        // Investigation log preserved with both outcomes
        const outcomes = restored!.investigation_log.map((e) => e.outcome);
        expect(outcomes).toContain("investigation_passed");
        expect(outcomes).toContain("denied");

        // Inventory preserved
        const inv = restored!.getInventory().map((a) => a.rel_path);
        expect(inv).toContain("README.md");

        // Session-modified preserved
        const fsm = explorer.getManifest();
        const db  = fsm.atoms.find((a) => a.rel_path === "src/db.ts")!;
        expect(restored!.session_modified.has(db.id)).toBe(true);
      } finally {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      }
    });
  });
});
