export interface SkillTarget {
  harnessId: string;
  harnessName: string;
  agentId: string;
}

export interface SkillCommandResult {
  stdout: string;
  stderr: string;
}

export const SKILL_AGENT_BY_HARNESS: Readonly<Record<string, string>>;
export function skillAgentForHarness(harnessId: string): string | null;
export function skillAgentIdsForHarnesses(harnessIds: string[]): string[];
export function detectSkillTargets(options: {
  serverRoot: string;
  runCommand?: (
    command: string,
    args: string[],
    options?: { cwd?: string; shell?: boolean },
  ) => Promise<SkillCommandResult>;
}): Promise<SkillTarget[]>;
export function installRobloxMcpSkill(options: {
  serverRoot: string;
  agentIds?: string[];
  dryRun?: boolean;
  runCommand?: (
    command: string,
    args: string[],
    options?: { cwd?: string; shell?: boolean },
  ) => Promise<SkillCommandResult>;
}): Promise<{ installedAgentIds: string[]; output: string }>;
