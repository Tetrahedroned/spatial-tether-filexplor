// Phase 10 — /api/reset_session test.
//
// The "↺ RESET" button in the UI is the escape hatch when the trail / visited
// state has accumulated noise the user wants to clear. The endpoint must:
//   1. wipe session.history
//   2. broadcast { type: "session_reset" } so all WS clients drop derived state
//   3. preserve current_room (the agent stays where it is — only history goes)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import WebSocket from "ws";
import { startHttpServer, RunningServer } from "../src/http-server";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");
const TEST_PORT = 4491;

function postJSON(url: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

describe("Phase 10: /api/reset_session", () => {
  let running: RunningServer | null = null;

  beforeAll(async () => {
    running = await startHttpServer(FIXTURE, { port: TEST_PORT });
  });
  afterAll(async () => {
    await running?.stop();
  });

  it("clears session history and broadcasts session_reset", async () => {
    // Build up some history so we have something to clear.
    await postJSON(`http://localhost:${TEST_PORT}/api/enter_room`, { focus: "src/auth.ts" });
    await postJSON(`http://localhost:${TEST_PORT}/api/enter_room`, { focus: "src/db.ts" });
    await postJSON(`http://localhost:${TEST_PORT}/api/enter_room`, { focus: "src/main.ts" });

    let sess = await fetch(`http://localhost:${TEST_PORT}/api/session`).then((r) => r.json());
    expect(sess.history.length).toBeGreaterThanOrEqual(3);
    const currentBeforeReset = sess.current_room;

    // Subscribe to WS so we can observe the broadcast.
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    const messages: any[] = [];
    ws.on("message", (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 1000);
      ws.once("open", () => { clearTimeout(t); resolve(); });
      ws.once("error", reject);
    });
    // Wait for init so we have a clean baseline.
    const t0 = Date.now();
    while (!messages.some((m) => m.type === "init") && Date.now() - t0 < 1000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(messages.some((m) => m.type === "init")).toBe(true);

    const r = await postJSON(`http://localhost:${TEST_PORT}/api/reset_session`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });

    await new Promise((res) => setTimeout(res, 200));
    expect(messages.some((m) => m.type === "session_reset")).toBe(true);

    // History was wiped. Current room is preserved (we re-push a single
    // visit for it so the trail can grow forward from "here").
    sess = await fetch(`http://localhost:${TEST_PORT}/api/session`).then((r) => r.json());
    expect(sess.current_room).toBe(currentBeforeReset);
    expect(sess.history.length).toBeLessThanOrEqual(1);
    if (sess.history.length === 1) {
      expect(sess.history[0].focus_path).toBe(currentBeforeReset);
    }

    ws.close();
  });

  it("returns 400 when there is no active session — wait, the server auto-creates one, so this branch is unreachable; instead returns ok on a fresh server", async () => {
    // Fresh server boot auto-creates a session, so reset is always safe.
    const r = await postJSON(`http://localhost:${TEST_PORT}/api/reset_session`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });
});
