#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  activateCandidateBuild,
  validateCandidateCore,
} from "./dashboard-update-runtime.mjs";
import {
  advanceCheckout,
  assertFastForward,
  inspectCleanCheckout,
  readCommit,
  restoreCheckout,
} from "./dashboard-update-git.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledRuntime =
  path.basename(scriptDirectory) === "updater" &&
  path.basename(path.dirname(scriptDirectory)) === "dist";
const serverRoot = path.resolve(
  process.env.ROBLOX_MCP_SERVER_ROOT ||
    (bundledRuntime
      ? path.resolve(scriptDirectory, "..", "..")
      : path.resolve(scriptDirectory, ".."))
);
const statusModuleUrl = pathToFileURL(
  bundledRuntime
    ? path.join(scriptDirectory, "..", "shared", "update-status.mjs")
    : path.join(serverRoot, "dist", "shared", "update-status.mjs")
).href;
const {
  acquireUpdateLock,
  releaseUpdateLock,
  writeUpdateStatus,
} = await import(statusModuleUrl);

const runId = argValue("--run-id");
const corePid = Number.parseInt(argValue("--core-pid") || "", 10);
const coreInstanceId = argValue("--core-instance-id");
const corePort =
  Number.parseInt(process.env.ROBLOX_MCP_PORT || "", 10) || 16384;
const operationStartedAt = Date.now();
let stagingRoot = null;
let stagingIsWorktree = false;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : "";
  return value && !value.startsWith("--") ? value : null;
}

function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore", shell: false }).status === 0;
}

function executable(command) {
  return process.platform === "win32" &&
    ["npm", "pnpm"].includes(command) &&
    !command.endsWith(".cmd")
    ? `${command}.cmd`
    : command;
}

async function run(
  command,
  args,
  { env = process.env, cwd = serverRoot } = {}
) {
  let output = "";
  await new Promise((resolve, reject) => {
    const commandToRun = executable(command);
    const useShell = process.platform === "win32" && commandToRun.endsWith(".cmd");
    const child = spawn(commandToRun, args, {
      cwd,
      env: { ...env, CI: "true" },
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}${
            output.trim() ? `\n\n${output.trim()}` : ""
          }`
        )
      );
    });
  });
}

async function status(state, message, extra = {}) {
  await writeUpdateStatus(
    {
      state,
      message,
      runId,
      startedAt: extra.startedAt || operationStartedAt,
      finishedAt: extra.finishedAt,
      error: extra.error,
      workerPid: process.pid,
    },
    { expectedRunId: runId }
  );
}

function trackingReference() {
  if (!commandExists("git")) return false;
  const result = spawnSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: serverRoot, encoding: "utf8", windowsHide: true }
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main() {
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid --run-id; expected a UUID.");
  }
  if (!Number.isInteger(corePid) || corePid <= 0) throw new Error("Invalid --core-pid.");
  if (!coreInstanceId) throw new Error("Missing --core-instance-id.");
  await acquireUpdateLock(runId);
  const startedAt = operationStartedAt;
  await status("running", "Checking the configured Git remote…", { startedAt });

  if (!commandExists("git")) throw new Error("Automatic updates require Git.");
  const checkout = inspectCleanCheckout(serverRoot);
  const tracking = trackingReference();
  if (tracking) {
    await status("running", "Downloading the latest version…", { startedAt });
    await run("git", ["fetch", "--prune"]);
  } else {
    await status(
      "running",
      "No tracking remote is configured; rebuilding the committed checkout…",
      { startedAt }
    );
  }

  const runner = commandExists("bun")
    ? "bun"
    : commandExists("pnpm")
      ? "pnpm"
      : "npm";
  stagingRoot = path.join(
    serverRoot,
    `.roblox-mcp-update-${runId}`
  );
  await run("git", [
    "worktree",
    "add",
    "--detach",
    stagingRoot,
    tracking || "HEAD",
  ]);
  stagingIsWorktree = true;
  await status("running", "Installing the staged dependencies…", { startedAt });
  await run(runner, ["install", "--ignore-scripts"], { cwd: stagingRoot });

  const candidateDist = path.join(stagingRoot, "dist");
  const candidateNodeModules = path.join(stagingRoot, "node_modules");
  await status("running", "Building and validating the update…", { startedAt });
  await run(runner, ["run", "build"], {
    cwd: stagingRoot,
  });
  await validateCandidateCore(candidateDist, stagingRoot);
  const targetCommit = readCommit(stagingRoot);
  assertFastForward(serverRoot, checkout.commit, targetCommit);

  await status("running", "Activating the complete verified release…", { startedAt });
  let result;
  let checkoutAdvanced = false;
  try {
    result = await activateCandidateBuild({
      serverRoot,
      candidateDist,
      candidateNodeModules,
      runId,
      corePid,
      coreInstanceId,
      corePort,
      commit: targetCommit,
      activateCheckout: () => {
        advanceCheckout(serverRoot, targetCommit, checkout.commit);
        checkoutAdvanced = true;
      },
      writeStatus: (next) => status(next.state, next.message, { startedAt }),
    });
  } catch (error) {
    if (checkoutAdvanced) {
      restoreCheckout(serverRoot, checkout.commit, targetCommit);
    }
    throw error;
  }
  await status("complete", result.message, {
    startedAt,
    finishedAt: Date.now(),
  }).catch(() => undefined);
}

main()
  .catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail.length > 1_500 ? `${detail.slice(0, 1_500)}…` : detail;
    if (runId) {
      await status("failed", `Automatic update failed: ${message}`, {
        finishedAt: Date.now(),
        error: message,
      }).catch(() => undefined);
    } else {
      console.error(`Automatic update failed: ${message}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    const safeStagingRoot =
      stagingRoot &&
      path.dirname(stagingRoot) === serverRoot &&
      path.basename(stagingRoot) === `.roblox-mcp-update-${runId}`;
    if (safeStagingRoot && stagingIsWorktree) {
      await run("git", ["worktree", "remove", "--force", stagingRoot]).catch(
        () => undefined
      );
    }
    if (safeStagingRoot) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (runId) await releaseUpdateLock(runId).catch(() => undefined);
  });
