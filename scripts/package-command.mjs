import fsSync from "node:fs";
import path from "node:path";

const PACKAGE_COMMANDS = new Set(["npm", "pnpm"]);

export function resolvePackageCommand(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const environment = options.env || process.env;
  const fileExists = options.fileExists || fsSync.existsSync;
  const normalizedCommand = String(command).replace(/\.cmd$/i, "").toLowerCase();

  if (platform !== "win32" || !PACKAGE_COMMANDS.has(normalizedCommand)) {
    return {
      command,
      args: [...args],
      shell: platform === "win32" && String(command).toLowerCase().endsWith(".cmd"),
    };
  }

  const pathApi = path.win32;
  const cliName = normalizedCommand === "npm" ? "npm-cli.js" : "pnpm.cjs";
  const configuredCli = String(environment.npm_execpath || "");
  const candidates = [
    pathApi.join(pathApi.dirname(execPath), "node_modules", "npm", "bin", cliName),
    pathApi.basename(configuredCli).toLowerCase() === cliName
      ? configuredCli
      : null,
    normalizedCommand === "pnpm" && environment.PNPM_HOME
      ? pathApi.join(environment.PNPM_HOME, cliName)
      : null,
  ].filter(Boolean);
  const cliPath = candidates.find((candidate) => fileExists(candidate));
  if (!cliPath) {
    throw new Error(
      `Could not locate ${cliName}. Reinstall Node.js with npm or make its CLI available on PATH.`
    );
  }

  return {
    command: execPath,
    args: [cliPath, ...args],
    shell: false,
  };
}
