import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DEFAULT_UPDATE_ARCHIVE_URL } from "./repository-source.mjs";

export { DEFAULT_UPDATE_ARCHIVE_URL } from "./repository-source.mjs";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function hasOwnGitCheckout(root) {
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return false;
  try {
    return fs.realpathSync.native(topLevel) === fs.realpathSync.native(root);
  } catch {
    return false;
  }
}

export function trackingReference(root) {
  if (!hasOwnGitCheckout(root)) return null;
  return git(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
}

function updateArchiveUrl(value) {
  const url = new URL(value || DEFAULT_UPDATE_ARCHIVE_URL);
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new Error("The update archive must use HTTPS (or loopback HTTP for local testing).");
  }
  return url;
}

async function downloadArchive(url, destination, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      Accept: "application/gzip, application/octet-stream",
      "User-Agent": "roblox-mcp-updater",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download the latest Roblox MCP archive (HTTP ${response.status}).`);
  }
  const advertisedSize = Number(response.headers.get("content-length") || 0);
  if (advertisedSize > MAX_ARCHIVE_BYTES) {
    throw new Error("The update archive is larger than the allowed 512 MB limit.");
  }
  if (!response.body) throw new Error("The update archive response was empty.");

  const digest = createHash("sha256");
  const handle = await fsPromises.open(destination, "wx", 0o600);
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error("The update archive exceeded the allowed 512 MB limit.");
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset
        );
        if (!bytesWritten) throw new Error("The update archive could not be saved completely.");
        offset += bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await reader.cancel().catch(() => undefined);
    await handle.close();
  }
  if (!received) throw new Error("The update archive response was empty.");
  return digest.digest("hex");
}

function inspectArchive(archivePath) {
  const listing = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listing.status !== 0) {
    throw new Error(listing.stderr.trim() || "The downloaded update archive is invalid.");
  }
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("The downloaded update archive is empty.");

  let rootName = null;
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("The downloaded update archive contains an unsafe path.");
    }
    const first = normalized.split("/")[0];
    if (!first || first === ".") {
      throw new Error("The downloaded update archive has an invalid root folder.");
    }
    rootName ||= first;
    if (first !== rootName) {
      throw new Error("The downloaded update archive must contain one repository root.");
    }
  }

  const verbose = spawnSync("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (verbose.status !== 0) {
    throw new Error(verbose.stderr.trim() || "The downloaded update archive could not be inspected.");
  }
  if (verbose.stdout.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
    throw new Error("The downloaded update archive contains unsupported links.");
  }
}

function extractArchive(archivePath, stagingRoot) {
  const extraction = spawnSync(
    "tar",
    [
      "-xzf",
      archivePath,
      "--strip-components=1",
      "--no-same-owner",
      "-C",
      stagingRoot,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (extraction.status !== 0) {
    throw new Error(extraction.stderr.trim() || "The update archive could not be extracted.");
  }
}

export async function prepareArchiveSource({
  serverRoot,
  stagingRoot,
  archiveUrl = process.env.ROBLOX_MCP_UPDATE_ARCHIVE_URL || DEFAULT_UPDATE_ARCHIVE_URL,
  fetchImpl = fetch,
}) {
  const resolvedStagingRoot = path.resolve(stagingRoot);
  if (
    path.dirname(resolvedStagingRoot) !== path.resolve(serverRoot) ||
    !path.basename(resolvedStagingRoot).startsWith(".roblox-mcp-update-")
  ) {
    throw new Error("Refusing to extract an update outside the installation directory.");
  }
  const archivePath = `${resolvedStagingRoot}.tar.gz`;
  await fsPromises.rm(resolvedStagingRoot, { recursive: true, force: true });
  await fsPromises.rm(archivePath, { force: true });
  await fsPromises.mkdir(resolvedStagingRoot, { recursive: true });
  try {
    const digest = await downloadArchive(
      updateArchiveUrl(archiveUrl),
      archivePath,
      fetchImpl
    );
    inspectArchive(archivePath);
    extractArchive(archivePath, resolvedStagingRoot);
    await Promise.all([
      fsPromises.access(path.join(resolvedStagingRoot, "package.json")),
      fsPromises.access(path.join(resolvedStagingRoot, "scripts", "build-server.mjs")),
    ]);
    return {
      kind: "archive",
      revision: `archive-${digest.slice(0, 12)}`,
      stagingRoot: resolvedStagingRoot,
      archivePath,
    };
  } catch (error) {
    await fsPromises.rm(resolvedStagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fsPromises.rm(archivePath, { force: true }).catch(() => undefined);
  }
}

export async function cleanupPreparedSource(source, runCommand) {
  if (!source?.stagingRoot) return;
  if (source.kind === "git") {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", source.stagingRoot],
      { cwd: source.serverRoot }
    ).catch(() => undefined);
  }
  await fsPromises.rm(source.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  if (source.archivePath) {
    await fsPromises.rm(source.archivePath, { force: true }).catch(() => undefined);
  }
}
