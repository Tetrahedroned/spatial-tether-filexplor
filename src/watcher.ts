import { EventEmitter } from "events";
import * as chokidar from "chokidar";

// ---------------------------------------------------------------------------
// FSWatcher — chokidar wrapper that batches change events and triggers
// gateway.refresh(). The gateway receives the diff and emits an `update`
// event of shape FSMUpdateEvent on its own emitter.
// ---------------------------------------------------------------------------

export interface FSMUpdateEvent {
  changed_atoms: string[];
  added: string[];
  updated: string[];
  removed: string[];
  timestamp: Date;
}

export interface WatcherOptions {
  debounceMs?: number;        // default 250ms
  ignored?: (string | RegExp)[];
}

export interface RefreshDiff {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface Watcher {
  stop(): Promise<void>;
}

const DEFAULT_IGNORED: (string | RegExp)[] = [
  /(^|[\\/])\../,                  // dotfiles and dotdirs (covers .spatial-tether, .git)
  /node_modules/,
  /\bdist\b/,
  /\bbuild\b/,
  /\bcoverage\b/,
];

export function startWatcher(
  projectRoot: string,
  refresh: () => RefreshDiff,
  events: EventEmitter,
  options: WatcherOptions = {},
): Watcher {
  const debounceMs = options.debounceMs ?? 250;
  const ignored    = options.ignored   ?? DEFAULT_IGNORED;

  const watcher = chokidar.watch(projectRoot, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });

  let timer: NodeJS.Timeout | null = null;

  const fire = () => {
    timer = null;
    let diff: RefreshDiff;
    try {
      diff = refresh();
    } catch (err) {
      events.emit("error", err);
      return;
    }
    const changed_atoms = [...diff.added, ...diff.updated, ...diff.removed];
    if (changed_atoms.length === 0) return;
    const event: FSMUpdateEvent = {
      changed_atoms,
      added:   diff.added,
      updated: diff.updated,
      removed: diff.removed,
      timestamp: new Date(),
    };
    events.emit("update", event);
  };

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  watcher.on("add",     trigger);
  watcher.on("change",  trigger);
  watcher.on("unlink",  trigger);
  watcher.on("addDir",  trigger);
  watcher.on("unlinkDir", trigger);
  // Robustness: chokidar surfaces EBUSY / EACCES / ENOENT (e.g. when the
  // watched dir is deleted out from under us) as `error` events. We must
  // never crash the process — log to stderr and stop the watcher gracefully
  // when the root vanishes. EventEmitter throws when no `error` listener
  // exists, so we always handle it ourselves.
  watcher.on("error", (err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    const code = e?.code;
    const msg  = (err as Error)?.message ?? String(err);
    console.error(`[spatial-tether] watcher error: ${msg}`);
    if (code === "ENOENT") {
      console.error(`[spatial-tether] watch root unavailable, stopping watcher`);
      watcher.close().catch(() => undefined);
    }
    // Re-emit only if any external listener exists, else swallow to avoid
    // EventEmitter's "Unhandled error" crash.
    if (events.listenerCount("error") > 0) {
      events.emit("error", err);
    }
  });

  return {
    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { await watcher.close(); } catch { /* already closed */ }
    },
  };
}
