export const USE_GITLAB = true;

const REPOSITORIES = Object.freeze({
  gitlab: Object.freeze({
    pageUrl: "https://gitlab.com/upio/roblox-executor-mcp",
    gitUrl: "https://gitlab.com/upio/roblox-executor-mcp.git",
    sshUrl: "git@gitlab.com:upio/roblox-executor-mcp.git",
    archiveUrl:
      "https://gitlab.com/upio/roblox-executor-mcp/-/archive/main/roblox-executor-mcp-main.tar.gz",
  }),
  github: Object.freeze({
    pageUrl: "https://github.com/notpoiu/roblox-executor-mcp",
    gitUrl: "https://github.com/notpoiu/roblox-executor-mcp.git",
    sshUrl: "git@github.com:notpoiu/roblox-executor-mcp.git",
    archiveUrl:
      "https://codeload.github.com/notpoiu/roblox-executor-mcp/tar.gz/refs/heads/main",
  }),
});

export function resolveRepositoryHost(
  environment = process.env,
  useGitLab = USE_GITLAB
) {
  const configuredHost = String(
    environment.ROBLOX_MCP_REPOSITORY_HOST || (useGitLab ? "gitlab" : "github")
  ).trim().toLowerCase();

  if (!Object.hasOwn(REPOSITORIES, configuredHost)) {
    throw new Error(
      `ROBLOX_MCP_REPOSITORY_HOST must be "gitlab" or "github", received "${configuredHost}".`
    );
  }
  return configuredHost;
}

export const REPOSITORY_HOST = resolveRepositoryHost();
export const ACTIVE_REPOSITORY = REPOSITORIES[REPOSITORY_HOST];
export const MAIN_REPO_URL = ACTIVE_REPOSITORY.gitUrl;
export const DEFAULT_UPDATE_ARCHIVE_URL = ACTIVE_REPOSITORY.archiveUrl;
