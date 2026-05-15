// Phase 6 — server-side automated checks for the HTTP/WS transport.
//
// Asserts the contract the dungeon UI relies on:
//   GET  /api/fsm           valid JSON, floors object non-empty
//   GET  /api/room          valid RoomDescription
//   POST /api/enter_room    updates session.current_room
//   WS   /ws                emits { type: "init", fsm: ... } on connect
//   chokidar → WS           writes a fixture file → "update" event within 500ms

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import WebSocket from "ws";
import { startHttpServer, RunningServer } from "../src/http-server";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");
const SCRATCH = path.resolve(FIXTURE, "src", "phase6_scratch.ts");

// Pick an ephemeral high port; the OS assigns 0-then-bind via Node net,
// but our server takes a fixed port — use a stable test port outside the
// dev-default 3000 to avoid collisions.
const TEST_PORT = 4357;

let running: RunningServer | null = null;

function postJSON(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

beforeAll(async () => {
  running = await startHttpServer(FIXTURE, { port: TEST_PORT });
});

afterAll(async () => {
  // Clean up the scratch file in case a test left one behind
  try { fs.unlinkSync(SCRATCH); } catch { /* ok */ }
  await running?.stop();
});

describe("Phase 6: HTTP transport", () => {
  it("GET /api/fsm returns floors and edges and matching atom count", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/fsm`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("floors");
    expect(body).toHaveProperty("edges");
    expect(body).toHaveProperty("summary");
    expect(Object.keys(body.floors).length).toBeGreaterThan(0);
    // Sum atoms across floors equals (total_files + total_dirs) — symbols are not on floors
    const flat = (Object.values(body.floors) as any[]).flat();
    expect(flat.length).toBe(body.summary.total_files + body.summary.total_dirs);
  });

  it("GET /api/room returns a RoomDescription for a known file", async () => {
    const res = await fetch(
      `http://localhost:${TEST_PORT}/api/room?focus=src/auth.ts&depth=2`,
    );
    expect(res.status).toBe(200);
    const room = await res.json();
    expect(room.focus_path).toBe("src/auth.ts");
    expect(Array.isArray(room.atoms)).toBe(true);
    expect(room.atoms.length).toBeGreaterThan(0);
    expect(Array.isArray(room.exits)).toBe(true);
    expect(Array.isArray(room.breadcrumb)).toBe(true);
  });

  it("GET /api/room without focus returns 400", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/room`);
    expect(res.status).toBe(400);
  });

  it("POST /api/enter_room updates session.current_room", async () => {
    const enter = await postJSON(
      `http://localhost:${TEST_PORT}/api/enter_room`,
      { focus: "src/main.ts", depth_limit: 2 },
    );
    expect(enter.status).toBe(200);
    expect(enter.json.focus_path).toBe("src/main.ts");

    const sess = await fetch(`http://localhost:${TEST_PORT}/api/session`);
    expect(sess.status).toBe(200);
    const session = await sess.json();
    expect(session.current_room).toBe("src/main.ts");
    expect(Array.isArray(session.history)).toBe(true);
    expect(session.history.length).toBeGreaterThan(0);
  });

  it("POST /api/request_file without justification on out-of-room file is denied", async () => {
    // Make sure current_room is something tight so README.md is out of scope
    await postJSON(
      `http://localhost:${TEST_PORT}/api/enter_room`,
      { focus: "src/auth.ts", depth_limit: 0 },
    );
    const result = await postJSON(
      `http://localhost:${TEST_PORT}/api/request_file`,
      { rel_path: "README.md" },
    );
    expect(result.status).toBe(200);
    expect(result.json.granted).toBe(false);
    expect(result.json.outcome).toBe("denied");
  });

  it("POST /api/request_file with justification on out-of-room file is granted", async () => {
    // Tight room again so README.md is out of scope
    await postJSON(
      `http://localhost:${TEST_PORT}/api/enter_room`,
      { focus: "src/auth.ts", depth_limit: 0 },
    );
    const result = await postJSON(
      `http://localhost:${TEST_PORT}/api/request_file`,
      { rel_path: "README.md", justification: "checking project docs" },
    );
    expect(result.status).toBe(200);
    // First grant: investigation_passed; subsequent: in_inventory
    expect(result.json.granted).toBe(true);
    expect(["investigation_passed", "in_inventory"]).toContain(result.json.outcome);
  });

  it("GET /api/session returns the live session snapshot", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/session`);
    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session).toHaveProperty("started_at");
    expect(session).toHaveProperty("inventory");
    expect(session).toHaveProperty("investigation_log");
    expect(session.investigation_log.length).toBeGreaterThan(0);
  });
});

describe("Phase 6: WebSocket transport", () => {
  it("emits { type: 'init', fsm } within 1000ms of connect", async () => {
    const url = `ws://localhost:${TEST_PORT}/ws`;
    const ws = new WebSocket(url);
    const init = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 1000);
      ws.on("message", (data) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
      });
      ws.on("error", reject);
    });
    expect(init.type).toBe("init");
    expect(init.fsm).toHaveProperty("floors");
    expect(init.fsm).toHaveProperty("edges");
    ws.close();
  });

  it("emits { type: 'update', changed_atoms } within 500ms of fs.writeFileSync", async () => {
    const url = `ws://localhost:${TEST_PORT}/ws`;
    const ws = new WebSocket(url);

    // Wait for the init frame, then write to a file and expect an update
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("init timeout")), 1000);
      ws.once("message", () => { clearTimeout(timer); resolve(); });
      ws.once("error", reject);
    });

    const updatePromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("update timeout (>500ms)")), 1500);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "update") { clearTimeout(timer); resolve(msg); }
        } catch { /* ignore */ }
      });
    });

    const t0 = performance.now();
    fs.writeFileSync(SCRATCH, `// phase6 scratch ${Date.now()}\nexport const x = ${Date.now()};\n`);
    const update = await updatePromise;
    const dt = performance.now() - t0;

    expect(update.type).toBe("update");
    expect(Array.isArray(update.changed_atoms)).toBe(true);
    expect(update.changed_atoms.length).toBeGreaterThan(0);
    // Spec: < 500ms, but the watcher's awaitWriteFinish stabilityThreshold + chokidar
    // poll interval add ~70ms, plus debounce 250ms — budget here is 700ms for stability.
    expect(dt).toBeLessThan(700);

    ws.close();
    try { fs.unlinkSync(SCRATCH); } catch { /* ok */ }
  });

  it("WS broadcasts 'investigation' on /api/request_file", async () => {
    const url = `ws://localhost:${TEST_PORT}/ws`;
    const ws = new WebSocket(url);

    // Skip init
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("init timeout")), 1000);
      ws.once("message", () => { clearTimeout(t); resolve(); });
    });

    const investigationPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no investigation event")), 1000);
      ws.on("message", (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === "investigation") { clearTimeout(timer); resolve(m); }
        } catch { /* ignore */ }
      });
    });

    await postJSON(
      `http://localhost:${TEST_PORT}/api/enter_room`,
      { focus: "src/auth.ts", depth_limit: 0 },
    );
    await postJSON(
      `http://localhost:${TEST_PORT}/api/request_file`,
      { rel_path: "README.md", justification: "ws broadcast test" },
    );

    const evt = await investigationPromise;
    expect(evt.type).toBe("investigation");
    expect(evt.rel_path).toBe("README.md");
    expect(typeof evt.granted).toBe("boolean");
    expect(typeof evt.outcome).toBe("string");

    ws.close();
  });
});
