// Phase 9 — /api/demo_step regression test.
//
// The UI's screensaver demo must NEVER trigger the LIVE indicator. This
// endpoint guarantees it: it updates session.current_room + history and
// returns the room JSON, but does NOT broadcast over the WebSocket. The
// control-case (/api/enter_room) confirms broadcasts still fire for real
// user navigation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import WebSocket from "ws";
import { startHttpServer, RunningServer } from "../src/http-server";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");
const TEST_PORT = 4481;

function postJSON(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

describe("Phase 9: /api/demo_step", () => {
  let running: RunningServer | null = null;

  beforeAll(async () => {
    running = await startHttpServer(FIXTURE, { port: TEST_PORT });
  });
  afterAll(async () => {
    await running?.stop();
  });

  it("POST /api/demo_step does NOT broadcast a room_change WS event", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    const messages: any[] = [];
    // Attach the message listener BEFORE awaiting open so the init frame is
    // never lost to a listener-registration race.
    ws.on("message", (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 1000);
      ws.once("open", () => { clearTimeout(t); resolve(); });
      ws.once("error", reject);
    });

    // Wait for the init frame to arrive so we have a clean baseline.
    const t0 = Date.now();
    while (!messages.some((m) => m.type === "init") && Date.now() - t0 < 1000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(messages.some((m) => m.type === "init")).toBe(true);

    const broadcastsBefore = messages.filter((m) => m.type === "room_change").length;

    // Demo path — no broadcast expected
    const demo = await postJSON(`http://localhost:${TEST_PORT}/api/demo_step`, {
      rel_path: "src/auth.ts",
    });
    expect(demo.status).toBe(200);
    expect(demo.json).toHaveProperty("focus_path");
    expect(demo.json.focus_path).toBe("src/auth.ts");

    await new Promise((r) => setTimeout(r, 250));
    const broadcastsAfterDemo = messages.filter((m) => m.type === "room_change").length;
    expect(broadcastsAfterDemo).toBe(broadcastsBefore);

    // Control: /api/enter_room SHOULD broadcast
    const real = await postJSON(`http://localhost:${TEST_PORT}/api/enter_room`, {
      focus: "src/main.ts", depth_limit: 2,
    });
    expect(real.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    const broadcastsAfterReal = messages.filter((m) => m.type === "room_change").length;
    expect(broadcastsAfterReal).toBeGreaterThan(broadcastsAfterDemo);
    const lastRoomChange = messages.filter((m) => m.type === "room_change").pop();
    expect(lastRoomChange.current_room).toBe("src/main.ts");

    ws.close();
  });

  it("POST /api/demo_step still updates the session's current_room", async () => {
    await postJSON(`http://localhost:${TEST_PORT}/api/demo_step`, {
      rel_path: "src/db.ts",
    });
    const sess = await fetch(`http://localhost:${TEST_PORT}/api/session`).then((r) => r.json());
    expect(sess.current_room).toBe("src/db.ts");
    expect(Array.isArray(sess.history)).toBe(true);
    expect(sess.history.length).toBeGreaterThan(0);
  });

  it("POST /api/demo_step rejects path traversal with 400", async () => {
    const r = await postJSON(`http://localhost:${TEST_PORT}/api/demo_step`, {
      rel_path: "../../../etc/passwd",
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/demo_step rejects missing rel_path with 400", async () => {
    const r = await postJSON(`http://localhost:${TEST_PORT}/api/demo_step`, {});
    expect(r.status).toBe(400);
  });
});
