import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { CreateDidaTaskOptions, DidaProjectData, DidaTaskSnapshot } from "../core/types";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ResolvedDidaCommand {
  command: string;
  version: string;
}

export interface WindowsCmdShim {
  command: string;
  argsPrefix: string[];
}

export interface DidaTask extends DidaTaskSnapshot {
  status?: number;
  completedTime?: string;
}

export interface DidaProject {
  id: string;
  name: string;
}

export interface DidaCliClientOptions {
  cliVersion?: string;
  maxCompletedQueries?: number;
  deadlineNow?: () => number;
  completedSnapshotDeadlineMs?: number;
}

interface CompletedTaskInterval {
  startSecond: number;
  endSecond: number;
}

const COMPLETED_TASK_LOWER_BOUND_SECOND = 0;
const DEFAULT_MAX_COMPLETED_QUERIES = 256;
const DEFAULT_COMPLETED_SNAPSHOT_DEADLINE_MS = 120_000;
interface SnapshotProtocol {
  resultLimit: number;
  completedUpperBoundSecond: number;
}

const SNAPSHOT_PROTOCOLS: ReadonlyMap<string, SnapshotProtocol> = new Map([
  ["0.1.10", {
    resultLimit: 200,
    completedUpperBoundSecond: Date.parse("9999-12-31T23:59:59Z") / 1_000
  }],
  // Verified on 2026-10-22 against the latest CLI release: both snapshot
  // commands still cap at 200 results and honour the completed-task bounds.
  ["0.1.14", {
    resultLimit: 200,
    completedUpperBoundSecond: Date.parse("9999-12-31T23:59:59Z") / 1_000
  }]
]);

/** Dida CLI releases whose task-snapshot protocol this plugin release verifies. */
export const VERIFIED_CLI_VERSIONS: readonly string[] = Object.freeze(
  Array.from(SNAPSHOT_PROTOCOLS.keys())
);

export const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const desktopPath = buildDesktopPath(process.env.PATH);
    const shim = resolveWindowsCmdShim(command, desktopPath);
    const commandPath = shim?.command ?? (shouldUseWindowsShell(command) ? "cmd.exe" : command);
    const commandArgs = shim
      ? [...shim.argsPrefix, ...args]
      : shouldUseWindowsShell(command)
        ? ["/d", "/s", "/c", buildWindowsCmdInvocation(command, args)]
        : args;
    execFile(commandPath, commandArgs, { env: { ...process.env, PATH: desktopPath }, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function shouldUseWindowsShell(command: string, platform = process.platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

export function resolveWindowsCmdShim(
  command: string,
  currentPath = buildDesktopPath(process.env.PATH),
  platform = process.platform
): WindowsCmdShim | undefined {
  if (!shouldUseWindowsShell(command, platform)) {
    return undefined;
  }

  const shimPath = findWindowsCommandPath(command, currentPath);
  if (!shimPath) {
    return undefined;
  }

  let content = "";
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }

  const scriptMatch = content.match(/"%dp0%\\([^"]+?\.js)"/i);
  if (!scriptMatch) {
    return undefined;
  }

  const baseDir = dirname(shimPath);
  const scriptPath = join(baseDir, scriptMatch[1].replace(/\\/g, sep));
  if (!existsSync(scriptPath)) {
    return undefined;
  }

  const localNode = join(baseDir, "node.exe");
  return {
    command: existsSync(localNode) ? localNode : "node",
    argsPrefix: [scriptPath]
  };
}

function findWindowsCommandPath(command: string, currentPath: string): string | undefined {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const candidates = hasPathSeparator ? [command] : currentPath.split(";").map((path) => join(path, command));
  return candidates.find((candidate) => existsSync(candidate));
}

export function buildWindowsCmdInvocation(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCmdArgument).join(" ");
}

function quoteWindowsCmdArgument(value: string): string {
  if (value.length > 0 && !/[\s"&|<>()^%!]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["&|<>()^%!])/g, "^$1")}"`;
}

export function buildDesktopPath(currentPath = "", home = homedir(), platform = process.platform): string {
  const separator = platform === "win32" ? ";" : ":";
  const paths =
    platform === "win32"
      ? [
          `${home}\\.hermes\\node\\bin`,
          `${home}\\AppData\\Roaming\\npm`,
          `${home}\\scoop\\shims`,
          `${home}\\AppData\\Local\\Microsoft\\WindowsApps`,
          "C:\\Program Files\\nodejs",
          "C:\\Windows\\System32",
          ...currentPath.split(separator)
        ]
      : [
          `${home}/.hermes/node/bin`,
          `${home}/.opencode/bin`,
          `${home}/.local/bin`,
          `${home}/bin`,
          `${home}/.local/share/pnpm`,
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          ...currentPath.split(separator)
        ];
  return [...new Set(paths.filter(Boolean))].join(separator);
}

function isBareCommand(command: string): boolean {
  return !command.includes("/") && !command.includes("\\");
}

async function readVersion(command: string, runner: CommandRunner): Promise<string> {
  const result = await runner(command, ["--version"]);
  return result.stdout.trim();
}

async function tryReadVersion(command: string, runner: CommandRunner): Promise<ResolvedDidaCommand | undefined> {
  try {
    return {
      command,
      version: await readVersion(command, runner)
    };
  } catch {
    return undefined;
  }
}

export async function resolveDidaCommand(
  configuredCommand = "dida",
  runner: CommandRunner = defaultRunner,
  platform = process.platform,
  home = homedir()
): Promise<ResolvedDidaCommand> {
  try {
    return {
      command: configuredCommand,
      version: await readVersion(configuredCommand, runner)
    };
  } catch (error) {
    if (!isBareCommand(configuredCommand)) {
      if (platform === "win32") {
        return resolveWindowsDidaCommand("dida", runner, home, [configuredCommand]);
      }
      throw new Error(`Unable to run dida CLI: ${(error as Error).message}`);
    }
  }

  if (platform === "win32") {
    return resolveWindowsDidaCommand(configuredCommand, runner, home);
  }

  const errors: string[] = [];
  const discoveryCommands: Array<[string, string[]]> = [
    ["/bin/zsh", ["-ilc", "command -v dida"]],
    ["/bin/zsh", ["-lc", "command -v dida"]],
    ["/bin/bash", ["-ilc", "command -v dida"]],
    ["/bin/bash", ["-lc", "command -v dida"]]
  ];

  for (const [command, args] of discoveryCommands) {
    try {
      const result = await runner(command, args);
      const discovered = result.stdout.trim().split(/\r?\n/)[0];
      if (!discovered) {
        continue;
      }
      return {
        command: discovered,
        version: await readVersion(discovered, runner)
      };
    } catch (error) {
      errors.push(`${command} ${args.join(" ")}: ${(error as Error).message}`);
      // Try the next discovery strategy.
    }
  }

  throw new Error(`Unable to run dida CLI. Tried ${configuredCommand} and shell discovery. ${errors.join(" | ")}`);
}

async function resolveWindowsDidaCommand(
  configuredCommand: string,
  runner: CommandRunner,
  home: string,
  previousTried: string[] = []
): Promise<ResolvedDidaCommand> {
  const tried = new Set<string>([...previousTried, configuredCommand]);
  const candidates = [
    `${configuredCommand}.cmd`,
    `${configuredCommand}.exe`,
    join(home, "AppData", "Roaming", "npm", `${configuredCommand}.cmd`),
    join(home, "scoop", "shims", `${configuredCommand}.cmd`)
  ];

  for (const candidate of candidates) {
    tried.add(candidate);
    const resolved = await tryReadVersion(candidate, runner);
    if (resolved) {
      return resolved;
    }
  }

  for (const commandName of [configuredCommand, `${configuredCommand}.cmd`]) {
    try {
      const result = await runner("where.exe", [commandName]);
      const discoveredCommands = result.stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const discovered of discoveredCommands) {
        tried.add(discovered);
        const resolved = await tryReadVersion(discovered, runner);
        if (resolved) {
          return resolved;
        }
      }
    } catch {
      // Try the next Windows discovery strategy.
    }
  }

  throw new Error(
    `Unable to run dida CLI. Tried ${Array.from(tried).join(", ")}. Install dida, add it to PATH, or provide its absolute path in plugin settings.`
  );
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

export class DidaCliClient {
  private readonly runner: CommandRunner;
  private readonly options: DidaCliClientOptions;

  constructor(command: string, runner?: CommandRunner, options?: DidaCliClientOptions);
  constructor(command: string, options?: DidaCliClientOptions);
  constructor(
    private readonly command: string,
    runnerOrOptions: CommandRunner | DidaCliClientOptions = defaultRunner,
    options: DidaCliClientOptions = {}
  ) {
    if (typeof runnerOrOptions === "function") {
      this.runner = runnerOrOptions;
      this.options = options;
    } else {
      this.runner = defaultRunner;
      this.options = runnerOrOptions;
    }
  }

  async testConnection(): Promise<string> {
    return readVersion(this.command, this.runner);
  }

  async listProjects(): Promise<DidaProject[]> {
    const result = await this.runner(this.command, ["project", "list", "--json"]);
    return parseJson<DidaProject[]>(result.stdout);
  }

  async getProjectData(projectId: string): Promise<DidaProjectData> {
    const result = await this.runner(this.command, ["project", "data", projectId, "--json"]);
    const parsed = parseJson<DidaProjectData>(result.stdout);
    if (
      !parsed
      || typeof parsed !== "object"
      || !Array.isArray(parsed.tasks)
      || !Array.isArray(parsed.columns)
    ) {
      throw new Error("Dida project data response is invalid");
    }
    return {
      project: parsed.project ?? { id: projectId, name: "" },
      tasks: parsed.tasks,
      columns: parsed.columns
    };
  }

  async listIncompleteTasks(projectIds: string[]): Promise<DidaTaskSnapshot[]> {
    const protocol = snapshotProtocol(this.options.cliVersion, "Incomplete");
    const args = ["task", "filter", "--status", "0"];
    if (projectIds.length > 0) {
      args.push("--projects", projectIds.join(","));
    }
    args.push("--json");
    const result = await this.runner(this.command, args);
    const tasks = parseJson<DidaTaskSnapshot[]>(result.stdout);
    if (!Array.isArray(tasks)) {
      throw new Error("Incomplete snapshot incomplete: CLI response is not an array");
    }
    if (tasks.length >= protocol.resultLimit) {
      throw new Error(
        `Incomplete snapshot incomplete: result limit of ${protocol.resultLimit} reached`
      );
    }
    const requestedProjectIds = new Set(projectIds);
    for (const task of tasks) {
      assertSnapshotTaskIdentity(task, requestedProjectIds, "Incomplete");
    }
    return tasks;
  }

  async createTask(projectId: string, title: string, options: CreateDidaTaskOptions = {}): Promise<DidaTask> {
    const args = [
      "task",
      "create",
      "--title",
      title,
      "--project",
      projectId
    ];
    if (options.content) {
      args.push("--content", options.content);
    }
    if (options.allDay) {
      args.push("--all-day");
    }
    if (options.startDate) {
      args.push("--start-date", options.startDate);
    }
    args.push("--json");
    const result = await this.runner(this.command, args);
    return parseJson<DidaTask>(result.stdout);
  }

  async updateTaskTitle(projectId: string, taskId: string, title: string): Promise<DidaTask> {
    const result = await this.runner(this.command, [
      "task",
      "update",
      taskId,
      "--id",
      taskId,
      "--project",
      projectId,
      "--title",
      title,
      "--json"
    ]);
    return parseJson<DidaTask>(result.stdout);
  }

  async setTaskParent(projectId: string, taskId: string, parentTaskId: string): Promise<DidaTask> {
    const result = await this.runner(this.command, [
      "task",
      "update",
      taskId,
      "--id",
      taskId,
      "--project",
      projectId,
      "--parent-id",
      parentTaskId,
      "--json"
    ]);
    return parseJson<DidaTask>(result.stdout);
  }

  async completeTask(projectId: string, taskId: string): Promise<void> {
    await this.runner(this.command, ["task", "complete", projectId, taskId]);
  }

  async listCompletedTasks(
    projectIds: string[],
    startSecond = COMPLETED_TASK_LOWER_BOUND_SECOND
  ): Promise<DidaTask[]> {
    const protocol = snapshotProtocol(this.options.cliVersion, "Completed");
    const endSecond = protocol.completedUpperBoundSecond;

    const maxQueries = this.options.maxCompletedQueries ?? DEFAULT_MAX_COMPLETED_QUERIES;
    const deadlineMs = this.options.completedSnapshotDeadlineMs
      ?? DEFAULT_COMPLETED_SNAPSHOT_DEADLINE_MS;
    const deadlineNow = this.options.deadlineNow ?? Date.now;
    const startedAt = deadlineNow();
    if (!Number.isFinite(startedAt)) {
      throw new Error("Completed snapshot incomplete: invalid deadline clock");
    }
    const intervals: CompletedTaskInterval[] = [{
      startSecond: Math.max(COMPLETED_TASK_LOWER_BOUND_SECOND, startSecond),
      endSecond
    }];
    const requestedProjectIds = new Set(projectIds);
    const completedTasks = new Map<string, DidaTask>();
    let queryCount = 0;

    while (intervals.length > 0) {
      assertCompletedSnapshotDeadline(deadlineNow, startedAt, deadlineMs);
      if (queryCount >= maxQueries) {
        throw new Error(`Completed snapshot incomplete: query budget of ${maxQueries} exhausted`);
      }
      const interval = intervals.pop()!;
      queryCount += 1;
      const tasks = await this.listCompletedTaskInterval(
        projectIds,
        requestedProjectIds,
        interval
      );
      assertCompletedSnapshotDeadline(deadlineNow, startedAt, deadlineMs);

      if (tasks.length >= protocol.resultLimit) {
        const shards = splitCompletedTaskInterval(interval);
        if (!shards) {
          throw new Error(
            `Completed snapshot incomplete: saturated one-second shard at ${formatUtcSecond(interval.startSecond)}`
          );
        }
        intervals.push(shards[1], shards[0]);
        continue;
      }

      for (const task of tasks) {
        completedTasks.set(`${task.projectId}\u0000${task.id}`, task);
      }
    }

    return [...completedTasks.values()];
  }

  private async listCompletedTaskInterval(
    projectIds: string[],
    requestedProjectIds: ReadonlySet<string>,
    interval: CompletedTaskInterval
  ): Promise<DidaTask[]> {
    const args = [
      "task",
      "completed",
      "--start-date",
      formatUtcSecond(interval.startSecond),
      "--end-date",
      formatUtcSecond(interval.endSecond)
    ];
    if (projectIds.length > 0) {
      args.push("--projects", projectIds.join(","));
    }
    args.push("--json");
    const result = await this.runner(this.command, args);
    const tasks = parseJson<DidaTask[]>(result.stdout);
    if (!Array.isArray(tasks)) {
      throw new Error("Completed snapshot incomplete: CLI response is not an array");
    }
    for (const task of tasks) {
      assertSnapshotTaskIdentity(task, requestedProjectIds, "Completed");
      const completedAt = typeof task.completedTime === "string"
        ? Date.parse(task.completedTime)
        : Number.NaN;
      if (
        !Number.isFinite(completedAt)
        || completedAt < interval.startSecond * 1_000
        || completedAt > interval.endSecond * 1_000
      ) {
        throw new Error(
          `Completed snapshot incomplete: task ${task.projectId ?? "?"}/${task.id ?? "?"} has an invalid or out-of-range completedTime`
        );
      }
    }
    return tasks;
  }
}

function snapshotProtocol(
  cliVersion: string | undefined,
  snapshotName: "Incomplete" | "Completed"
): SnapshotProtocol {
  const normalizedVersion = cliVersion?.trim().replace(/^v/i, "") ?? "";
  const protocol = SNAPSHOT_PROTOCOLS.get(normalizedVersion);
  if (!protocol) {
    const displayedVersion = cliVersion?.trim() || "missing";
    throw new Error(
      `${snapshotName} snapshot unsupported for dida CLI version ${displayedVersion}; verified versions: ${VERIFIED_CLI_VERSIONS.join(", ")}`
    );
  }
  return protocol;
}

function assertSnapshotTaskIdentity(
  task: DidaTaskSnapshot,
  requestedProjectIds: ReadonlySet<string>,
  snapshotName: "Incomplete" | "Completed"
): void {
  if (typeof task?.id !== "string" || task.id.trim().length === 0) {
    throw new Error(`${snapshotName} snapshot incomplete: task has an invalid id`);
  }
  if (typeof task.projectId !== "string" || task.projectId.trim().length === 0) {
    throw new Error(`${snapshotName} snapshot incomplete: task ${task.id} has an invalid projectId`);
  }
  if (requestedProjectIds.size > 0 && !requestedProjectIds.has(task.projectId)) {
    throw new Error(
      `${snapshotName} snapshot incomplete: task ${task.projectId}/${task.id} is outside the requested projects`
    );
  }
}

function assertCompletedSnapshotDeadline(
  deadlineNow: () => number,
  startedAt: number,
  deadlineMs: number
): void {
  const elapsedMs = deadlineNow() - startedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs >= deadlineMs) {
    throw new Error(
      `Completed snapshot incomplete: wall-clock deadline of ${deadlineMs}ms exhausted`
    );
  }
}

function formatUtcSecond(epochSecond: number): string {
  return new Date(epochSecond * 1_000).toISOString().replace(".000Z", "Z");
}

function splitCompletedTaskInterval(
  interval: CompletedTaskInterval
): [CompletedTaskInterval, CompletedTaskInterval] | undefined {
  if (interval.endSecond - interval.startSecond <= 1) return undefined;
  const midpoint = Math.floor((interval.startSecond + interval.endSecond) / 2);
  return [
    { startSecond: interval.startSecond, endSecond: midpoint },
    { startSecond: midpoint, endSecond: interval.endSecond }
  ];
}
