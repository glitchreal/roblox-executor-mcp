import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coreInstanceId, SERVER_ROOT } from "../../../config.js";
import {
  readUpdateLock,
  readUpdateStatus,
  updateWorkerIsRunning,
  writeUpdateStatus,
} from "../../../shared/update-status.mjs";

const WORKER_PATH = fileURLToPath(
  new URL("../../../updater/dashboard-update-worker.mjs", import.meta.url)
);
const REPO_ROOT = SERVER_ROOT;
const STARTING_STATUS_MAX_AGE_MS = 5_000;
let launchInProgress = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function hasGitCheckout(): boolean {
  if (!fs.existsSync(WORKER_PATH)) return false;
  const result = spawnSync(
    "git",
    ["rev-parse", "--show-toplevel"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      windowsHide: true,
    }
  );
  if (result.status !== 0) return false;
  try {
    return (
      fs.realpathSync.native(result.stdout.trim()) ===
      fs.realpathSync.native(REPO_ROOT)
    );
  } catch {
    return false;
  }
}

async function cleanupOrphanedWorktree(runId: unknown): Promise<void> {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) return;
  const stagingRoot = path.join(REPO_ROOT, `.roblox-mcp-update-${runId}`);
  if (path.dirname(stagingRoot) !== REPO_ROOT) return;
  spawnSync("git", ["worktree", "remove", "--force", stagingRoot], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    windowsHide: true,
  });
  await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  spawnSync("git", ["worktree", "prune"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    windowsHide: true,
  });

  const releasesRoot = path.join(REPO_ROOT, ".roblox-mcp-releases");
  let activeRelease = "";
  try {
    const pointer = JSON.parse(
      await fsPromises.readFile(
        path.join(REPO_ROOT, ".roblox-mcp-current.json"),
        "utf8"
      )
    );
    activeRelease = path.resolve(pointer.releaseRoot || "");
  } catch {
    // No active versioned release.
  }
  for (const entry of await fsPromises.readdir(releasesRoot).catch(() => [])) {
    const releaseRoot = path.join(releasesRoot, entry);
    if (entry.endsWith(`-${runId}`) && path.resolve(releaseRoot) !== activeRelease) {
      await fsPromises.rm(releaseRoot, { recursive: true, force: true });
    }
  }
}

async function currentUpdateStatus(): Promise<Record<string, unknown>> {
  const current = await readUpdateStatus();
  if (!hasGitCheckout()) {
    return {
      state: "unavailable",
      available: false,
      message: "Automatic updates require a Git checkout.",
    };
  }
  if (current.state !== "running" && current.state !== "restarting") {
    return { ...current, available: true };
  }

  const lock = await readUpdateLock();
  const lockMatches = Boolean(
    lock && lock.runId === current.runId && updateWorkerIsRunning(lock)
  );
  const recentlyStarted =
    typeof current.updatedAt === "number" &&
    Date.now() - current.updatedAt < STARTING_STATUS_MAX_AGE_MS;
  if (lockMatches || recentlyStarted) {
    return { ...current, available: true };
  }

  await cleanupOrphanedWorktree(current.runId);
  const failed = {
    ...current,
    state: "failed" as const,
    message: "The update worker stopped before the update completed. You can try again.",
    finishedAt: Date.now(),
    error: "Update worker is no longer running.",
  };
  await writeUpdateStatus(failed, {
    expectedRunId: typeof current.runId === "string" ? current.runId : undefined,
  });
  return { ...failed, available: true };
}

export async function GET(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  json(res, 200, await currentUpdateStatus());
}

export async function POST(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (launchInProgress) {
    json(res, 409, { error: "An update is already starting." });
    return;
  }

  launchInProgress = true;
  try {
    if (!hasGitCheckout()) {
      json(res, 409, { error: "Automatic updates require a Git checkout." });
      return;
    }
    const lock = await readUpdateLock();
    if (lock && updateWorkerIsRunning(lock)) {
      json(res, 409, { error: "An update is already in progress." });
      return;
    }

    const current = await readUpdateStatus();
    if (
      (current.state === "running" || current.state === "restarting") &&
      typeof current.updatedAt === "number" &&
      Date.now() - current.updatedAt < STARTING_STATUS_MAX_AGE_MS
    ) {
      json(res, 409, { error: "An update is already in progress.", ...current });
      return;
    }

    const startedAt = Date.now();
    const runId = randomUUID();
    const initialStatus = {
      state: "running" as const,
      message: "Starting the automatic update…",
      startedAt,
      runId,
    };
    await writeUpdateStatus(initialStatus);

    const child = spawn(
      process.execPath,
      [
        WORKER_PATH,
        "--run-id",
        runId,
        "--core-pid",
        String(process.pid),
        "--core-instance-id",
        coreInstanceId,
      ],
      {
        cwd: REPO_ROOT,
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    try {
      await once(child, "spawn");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        state: "failed",
        message: "The updater could not be started.",
        startedAt,
        finishedAt: Date.now(),
        runId,
        error: message,
      } as const;
      await writeUpdateStatus(failed, { expectedRunId: runId });
      json(res, 500, failed);
      return;
    }
    child.unref();

    json(res, 202, { ...initialStatus, workerPid: child.pid });
  } finally {
    launchInProgress = false;
  }
}
