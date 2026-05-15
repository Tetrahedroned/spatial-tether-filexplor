// Phase 8 — server endpoints feeding the in-UI scroll editor + local git
// ledger. Two HTTP servers in this file:
//   - one rooted at fixtures/ts-app (file read/write tests)
//   - one rooted at a temp dir freshly `git init`'d (git command tests)
//
// All tests are server-only; the UI is not exercised here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFileSync } from "child_process";
import { startHttpServer, RunningServer } from "../src/http-server";

const FIXTURE = path.resolve(__dirname, "../fixtures/ts-app");
const FILE_PORT = 4471;
const GIT_PORT  = 4472;
const NON_GIT_PORT = 4473;

function postJSON(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

// ─── Helpers to spin up a temp git repo ─────────────────────────────────────
function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitInitRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // Local-only identity so commits don't fail on a CI box without a global config
  execFileSync("git", ["config", "user.email", "phase8@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name",  "phase8"],              { cwd: dir });
  fs.writeFileSync(path.join(dir, "seed.txt"), "first line\n");
}

// ───────────────────────────────────────────────────────────────────────────
// SUITE 1 — /api/file  (read + write)
// ───────────────────────────────────────────────────────────────────────────

describe("Phase 8: /api/file (read + write)", () => {
  let running: RunningServer | null = null;
  const SCRATCH = "src/_phase8_editor_tmp.ts";
  const SCRATCH_ABS = path.join(FIXTURE, SCRATCH);

  beforeAll(async () => {
    running = await startHttpServer(FIXTURE, { port: FILE_PORT });
  });
  afterAll(async () => {
    try { fs.unlinkSync(SCRATCH_ABS); } catch { /* ok */ }
    await running?.stop();
  });

  it("GET /api/file returns content + lines + size for a known fixture file", async () => {
    const res = await fetch(`http://localhost:${FILE_PORT}/api/file?path=src/auth.ts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("src/auth.ts");
    expect(typeof body.content).toBe("string");
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.lines).toBeGreaterThan(0);
    expect(body.size).toBeGreaterThan(0);
  });

  it("GET /api/file rejects path traversal with 400", async () => {
    const res = await fetch(
      `http://localhost:${FILE_PORT}/api/file?path=${encodeURIComponent("../../../etc/passwd")}`
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/file writes and the next GET reads the new content back", async () => {
    const content = `// phase8 ${Date.now()}\nexport const x = 42;\n`;
    const w = await postJSON(`http://localhost:${FILE_PORT}/api/file`, {
      path: SCRATCH, content,
    });
    expect(w.status).toBe(200);
    expect(w.json.ok).toBe(true);
    expect(w.json.path).toBe(SCRATCH);
    expect(typeof w.json.written_at).toBe("string");

    const r = await fetch(`http://localhost:${FILE_PORT}/api/file?path=${encodeURIComponent(SCRATCH)}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.content).toBe(content);
  });

  it("POST /api/file rejects path traversal with 400", async () => {
    const r = await postJSON(`http://localhost:${FILE_PORT}/api/file`, {
      path: "../../../tmp/phase8_attack.txt",
      content: "should never be written",
    });
    expect(r.status).toBe(400);
    expect(fs.existsSync("/tmp/phase8_attack.txt")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SUITE 2 — /api/git in a freshly init'd repo
// ───────────────────────────────────────────────────────────────────────────

describe("Phase 8: /api/git (whitelist)", () => {
  let running: RunningServer | null = null;
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkTmpDir("st-phase8-git-");
    gitInitRepo(repoDir);
    running = await startHttpServer(repoDir, { port: GIT_PORT });
  });
  afterAll(async () => {
    await running?.stop();
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("POST /api/git status → ok=true, output is a string", async () => {
    const r = await postJSON(`http://localhost:${GIT_PORT}/api/git`, { command: "status" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.command).toBe("status");
    expect(typeof r.json.output).toBe("string");
    expect(r.json.exit_code).toBe(0);
    // The seed file is untracked at this point
    expect(r.json.output).toMatch(/seed\.txt/);
  });

  it("POST /api/git push → 400 (not in whitelist)", async () => {
    const r = await postJSON(`http://localhost:${GIT_PORT}/api/git`, { command: "push" });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
    expect(String(r.json.error)).toMatch(/whitelist/);
  });

  it("POST /api/git commit without a message → 400", async () => {
    const r = await postJSON(`http://localhost:${GIT_PORT}/api/git`, { command: "commit" });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
  });

  it("POST /api/git add then commit → ok=true and exit_code=0", async () => {
    const a = await postJSON(`http://localhost:${GIT_PORT}/api/git`, { command: "add" });
    expect(a.json.ok).toBe(true);
    const c = await postJSON(`http://localhost:${GIT_PORT}/api/git`, {
      command: "commit", message: "phase 8 initial",
    });
    expect(c.json.ok).toBe(true);
    expect(c.json.exit_code).toBe(0);
    // The follow-up log entry should mention the message
    const log = await postJSON(`http://localhost:${GIT_PORT}/api/git`, { command: "log" });
    expect(log.json.ok).toBe(true);
    expect(log.json.output).toMatch(/phase 8 initial/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SUITE 3 — /api/git outside any git repo
// ───────────────────────────────────────────────────────────────────────────

describe("Phase 8: /api/git outside a git repo", () => {
  let running: RunningServer | null = null;
  let nonRepo: string;

  beforeAll(async () => {
    nonRepo = mkTmpDir("st-phase8-nogit-");
    fs.writeFileSync(path.join(nonRepo, "lonely.txt"), "no .git here\n");
    running = await startHttpServer(nonRepo, { port: NON_GIT_PORT });
  });
  afterAll(async () => {
    await running?.stop();
    try { fs.rmSync(nonRepo, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("POST /api/git status → ok=false, error mentions 'not a git repository'", async () => {
    const r = await postJSON(`http://localhost:${NON_GIT_PORT}/api/git`, { command: "status" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(String(r.json.error)).toMatch(/not a git repository/i);
  });
});
