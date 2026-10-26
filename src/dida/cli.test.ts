import { describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDesktopPath,
  buildWindowsCmdInvocation,
  DidaCliClient,
  resolveDidaCommand,
  resolveWindowsCmdShim,
  type DidaCliClientOptions
} from "./cli";
import { DidaCliGateway } from "./gateway";

const completedOptions = (overrides: Partial<DidaCliClientOptions> = {}): DidaCliClientOptions => ({
  cliVersion: "0.1.10",
  ...overrides
});

describe("resolveDidaCommand", () => {
  test("uses the configured command when it runs", async () => {
    const result = await resolveDidaCommand("dida", async (command, args) => {
      expect(command).toBe("dida");
      expect(args).toEqual(["--version"]);
      return { stdout: "0.1.10", stderr: "" };
    });

    expect(result).toEqual({ command: "dida", version: "0.1.10" });
  });

  test("falls back to shell discovery when bare command is not on PATH", async () => {
    const calls: string[] = [];
    const result = await resolveDidaCommand(
      "dida",
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "dida") {
          throw new Error("not found");
        }
        if (args.includes("command -v dida")) {
          return { stdout: "/opt/homebrew/bin/dida\n", stderr: "" };
        }
        if (command === "/opt/homebrew/bin/dida") {
          return { stdout: "0.1.10\n", stderr: "" };
        }
        throw new Error("unexpected command");
      },
      "darwin"
    );

    expect(result).toEqual({ command: "/opt/homebrew/bin/dida", version: "0.1.10" });
    expect(calls).toContain("/bin/zsh -ilc command -v dida");
  });

  test("falls back to dida.cmd on Windows when the bare command is not runnable", async () => {
    const calls: string[] = [];
    const result = await resolveDidaCommand(
      "dida",
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "dida.cmd") {
          return { stdout: "0.1.10\n", stderr: "" };
        }
        throw new Error("not found");
      },
      "win32",
      "C:\\Users\\lance"
    );

    expect(result).toEqual({ command: "dida.cmd", version: "0.1.10" });
    expect(calls).toEqual(["dida --version", "dida.cmd --version"]);
  });

  test("rediscovers dida on Windows when a cached absolute path is stale", async () => {
    const calls: string[] = [];
    const result = await resolveDidaCommand(
      "/Users/lance/.hermes/node/bin/dida",
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "dida.cmd") {
          return { stdout: "0.1.10\n", stderr: "" };
        }
        throw new Error("not found");
      },
      "win32",
      "C:\\Users\\lance"
    );

    expect(result).toEqual({ command: "dida.cmd", version: "0.1.10" });
    expect(calls).toEqual(["/Users/lance/.hermes/node/bin/dida --version", "dida.cmd --version"]);
  });

  test("uses where.exe discovery on Windows when command shims are outside common paths", async () => {
    const result = await resolveDidaCommand(
      "dida",
      async (command, args) => {
        if (command === "where.exe" && args[0] === "dida") {
          return { stdout: "D:\\Tools\\npm\\dida.cmd\n", stderr: "" };
        }
        if (command === "D:\\Tools\\npm\\dida.cmd") {
          return { stdout: "0.1.10\n", stderr: "" };
        }
        throw new Error("not found");
      },
      "win32",
      "C:\\Users\\lance"
    );

    expect(result).toEqual({ command: "D:\\Tools\\npm\\dida.cmd", version: "0.1.10" });
  });

  test("does not shell-discover absolute paths", async () => {
    await expect(
      resolveDidaCommand("/missing/dida", async () => {
        throw new Error("not found");
      })
    ).rejects.toThrow("Unable to run dida CLI");
  });
});

describe("buildDesktopPath", () => {
  test("adds common user binary locations for desktop-launched SiYuan", () => {
    const path = buildDesktopPath("/usr/bin:/bin", "/Users/lance", "darwin");

    expect(path.split(":")).toContain("/Users/lance/.hermes/node/bin");
    expect(path.split(":")).toContain("/opt/homebrew/bin");
    expect(path.split(":")).toContain("/usr/bin");
  });

  test("uses Windows path delimiter and common Windows locations", () => {
    const path = buildDesktopPath("C:\\Windows\\System32;C:\\Tools", "C:\\Users\\lance", "win32");
    const parts = path.split(";");

    expect(parts).toContain("C:\\Users\\lance\\.hermes\\node\\bin");
    expect(parts).toContain("C:\\Users\\lance\\AppData\\Roaming\\npm");
    expect(parts).toContain("C:\\Windows\\System32");
    expect(parts).not.toContain("C:\\Windows\\System32:C:\\Tools");
  });
});

describe("buildWindowsCmdInvocation", () => {
  test("quotes a task title with spaces as one Windows command argument", () => {
    const command = buildWindowsCmdInvocation("dida.cmd", [
      "task",
      "create",
      "--title",
      "解决问题：滴答同步失败 v3.7.0-rc.1",
      "--project",
      "project-1",
      "--json"
    ]);

    expect(command).toBe('dida.cmd task create --title "解决问题：滴答同步失败 v3.7.0-rc.1" --project project-1 --json');
  });
});

describe("resolveWindowsCmdShim", () => {
  test("turns an npm cmd shim into a direct node script invocation", () => {
    const root = join(tmpdir(), `siyuan-dida-${Date.now()}`);
    const npmDir = join(root, "npm");
    const scriptDir = join(npmDir, "node_modules", "@suibiji", "dida-cli", "dist");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(npmDir, "dida.cmd"),
      '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@suibiji\\dida-cli\\dist\\index.js" %*\r\n'
    );
    writeFileSync(join(scriptDir, "index.js"), "");

    try {
      expect(resolveWindowsCmdShim("dida.cmd", npmDir, "win32")).toEqual({
        command: "node",
        argsPrefix: [join(scriptDir, "index.js")]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("DidaCliClient", () => {
  function completedTask(id: string, completedTime: string, projectId = "project-1") {
    return { id, projectId, completedTime };
  }

  function flagValue(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${flag}`);
    return args[index + 1];
  }

  test("lists incomplete tasks for the requested projects", async () => {
    const client = new DidaCliClient(
      "dida",
      async (command, args) => {
        expect(command).toBe("dida");
        expect(args).toEqual([
          "task",
          "filter",
          "--status",
          "0",
          "--projects",
          "project-1,project-2",
          "--json"
        ]);
        return {
          stdout: JSON.stringify([
            {
              id: "task-1",
              projectId: "project-1",
              title: "整理会议纪要",
              content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
            },
            { id: "task-2", projectId: "project-2" }
          ]),
          stderr: ""
        };
      },
      completedOptions()
    );

    await expect(client.listIncompleteTasks(["project-1", "project-2"])).resolves.toEqual([
      {
        id: "task-1",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      },
      { id: "task-2", projectId: "project-2" }
    ]);
  });

  test("lists incomplete tasks across projects when no project filter is provided", async () => {
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        expect(args).toEqual(["task", "filter", "--status", "0", "--json"]);
        return { stdout: "[]", stderr: "" };
      },
      completedOptions()
    );

    await expect(client.listIncompleteTasks([])).resolves.toEqual([]);
  });

  test.each([undefined, "", "0.1.9", "0.1.11", "0.1.13", "0.1.15", "toString", "constructor", "__proto__"])(
    "rejects unsupported CLI version %j before requesting incomplete tasks",
    async (cliVersion) => {
      let calls = 0;
      const client = new DidaCliClient(
        "dida",
        async () => {
          calls += 1;
          return { stdout: "[]", stderr: "" };
        },
        completedOptions({ cliVersion })
      );

      await expect(client.listIncompleteTasks(["project-1"]))
        .rejects.toThrow(/incomplete snapshot.*unsupported|unsupported.*incomplete snapshot/i);
      expect(calls).toBe(0);
    }
  );

  test("rejects a saturated incomplete snapshot", async () => {
    const client = new DidaCliClient(
      "dida",
      async () => ({
        stdout: JSON.stringify(
          Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, projectId: "project-1" }))
        ),
        stderr: ""
      }),
      completedOptions()
    );

    await expect(client.listIncompleteTasks(["project-1"]))
      .rejects.toThrow(/incomplete snapshot.*200|incomplete snapshot.*limit/i);
  });

  test.each([
    ["non-array response", { tasks: [] }],
    ["missing id", [{ projectId: "project-1" }]],
    ["empty id", [{ id: " ", projectId: "project-1" }]],
    ["missing projectId", [{ id: "task-1" }]],
    ["empty projectId", [{ id: "task-1", projectId: " " }]],
    ["foreign project", [{ id: "task-1", projectId: "project-2" }]]
  ])("rejects an unsafe incomplete snapshot with %s", async (_label, response) => {
    const client = new DidaCliClient(
      "dida",
      async () => ({ stdout: JSON.stringify(response), stderr: "" }),
      completedOptions()
    );

    await expect(client.listIncompleteTasks(["project-1"]))
      .rejects.toThrow(/incomplete snapshot/i);
  });

  test("creates a task with json output", async () => {
    const client = new DidaCliClient("dida", async (command, args) => {
      expect(command).toBe("dida");
      expect(args).toEqual([
        "task",
        "create",
        "--title",
        "整理会议纪要",
        "--project",
        "project-1",
        "--content",
        "来源：思源笔记",
        "--all-day",
        "--start-date",
        "2026-07-02T00:00:00+0800",
        "--json"
      ]);
      return { stdout: JSON.stringify({ id: "task-1", projectId: "project-1" }), stderr: "" };
    });

    await expect(
      client.createTask("project-1", "整理会议纪要", {
        content: "来源：思源笔记",
        allDay: true,
        startDate: "2026-07-02T00:00:00+0800"
      })
    ).resolves.toEqual({
      id: "task-1",
      projectId: "project-1"
    });
  });

  test("sets a task parent with the update command", async () => {
    const client = new DidaCliClient("dida", async (command, args) => {
      expect(command).toBe("dida");
      expect(args).toEqual([
        "task",
        "update",
        "task-2",
        "--id",
        "task-2",
        "--project",
        "project-1",
        "--parent-id",
        "task-1",
        "--json"
      ]);
      return { stdout: JSON.stringify({ id: "task-2", projectId: "project-1" }), stderr: "" };
    });

    await expect(client.setTaskParent("project-1", "task-2", "task-1")).resolves.toEqual({
      id: "task-2",
      projectId: "project-1"
    });
  });

  test("loads one unsaturated completed-task shard with bounded UTC dates and project filters", async () => {
    const client = new DidaCliClient(
      "dida",
      async (command, args) => {
        expect(command).toBe("dida");
        expect(args).toEqual([
          "task",
          "completed",
          "--start-date",
          "1970-01-01T00:00:00Z",
          "--end-date",
          "9999-12-31T23:59:59Z",
          "--projects",
          "project-1,project-2",
          "--json"
        ]);
        return {
          stdout: JSON.stringify([
            completedTask("task-1", "2029-12-31T23:59:59.500Z", "project-1")
          ]),
          stderr: ""
        };
      },
      completedOptions()
    );

    await expect(client.listCompletedTasks(["project-1", "project-2"])).resolves.toEqual([
      completedTask("task-1", "2029-12-31T23:59:59.500Z", "project-1")
    ]);
  });

  test("omits the completed-task project filter when no projects are configured", async () => {
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        expect(args).toEqual([
          "task",
          "completed",
          "--start-date",
          "1970-01-01T00:00:00Z",
          "--end-date",
          "9999-12-31T23:59:59Z",
          "--json"
        ]);
        return { stdout: "[]", stderr: "" };
      },
      completedOptions()
    );

    await expect(client.listCompletedTasks([])).resolves.toEqual([]);
  });

  test("honours a startSecond lower bound for incremental completed pulls", async () => {
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        expect(args).toEqual([
          "task",
          "completed",
          "--start-date",
          "2023-11-14T22:13:20Z",
          "--end-date",
          "9999-12-31T23:59:59Z",
          "--json"
        ]);
        return { stdout: "[]", stderr: "" };
      },
      completedOptions()
    );

    await expect(client.listCompletedTasks([], 1_700_000_000)).resolves.toEqual([]);
  });

  test("splits a saturated completed-task range and merges more than 200 unique tasks", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        const start = flagValue(args, "--start-date");
        const end = flagValue(args, "--end-date");
        if (calls === 1) {
          return {
            stdout: JSON.stringify(
              Array.from({ length: 200 }, (_, index) => completedTask(`root-${index}`, start))
            ),
            stderr: ""
          };
        }
        const count = calls === 2 ? 150 : 100;
        return {
          stdout: JSON.stringify(
            Array.from({ length: count }, (_, index) =>
              completedTask(`${calls === 2 ? "left" : "right"}-${index}`, calls === 2 ? start : end)
            )
          ),
          stderr: ""
        };
      },
      completedOptions()
    );

    const tasks = await client.listCompletedTasks(["project-1"]);

    expect(tasks).toHaveLength(250);
    expect(new Set(tasks.map((task) => `${task.projectId}:${task.id}`)).size).toBe(250);
    expect(calls).toBe(3);
  });

  test("deduplicates a task returned at an inclusive split boundary", async () => {
    let calls = 0;
    let boundary = "";
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        const start = flagValue(args, "--start-date");
        const end = flagValue(args, "--end-date");
        if (calls === 1) {
          return {
            stdout: JSON.stringify(
              Array.from({ length: 200 }, (_, index) => completedTask(`root-${index}`, start))
            ),
            stderr: ""
          };
        }
        if (calls === 2) boundary = end;
        return {
          stdout: JSON.stringify([
            completedTask("boundary", boundary),
            completedTask(calls === 2 ? "left" : "right", calls === 2 ? start : end)
          ]),
          stderr: ""
        };
      },
      completedOptions()
    );

    const tasks = await client.listCompletedTasks(["project-1"]);

    expect(tasks.map((task) => task.id).sort()).toEqual(["boundary", "left", "right"]);
    expect(calls).toBe(3);
  });

  test("recursively splits a nested saturated completed-task shard", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        const start = flagValue(args, "--start-date");
        const end = flagValue(args, "--end-date");
        const count = calls === 1 || calls === 2 ? 200 : 1;
        return {
          stdout: JSON.stringify(
            Array.from({ length: count }, (_, index) => completedTask(`call-${calls}-${index}`, start === end ? start : end))
          ),
          stderr: ""
        };
      },
      completedOptions()
    );

    await expect(client.listCompletedTasks(["project-1"])).resolves.toHaveLength(3);
    expect(calls).toBe(5);
  });

  test.each([
    ["missing", undefined],
    ["invalid", "not-a-date"],
    ["before the requested interval", "1969-12-31T23:59:59Z"],
    ["after the requested interval", "+010000-01-01T00:00:00Z"],
    ["after the inclusive endpoint within the same second", "9999-12-31T23:59:59.001Z"]
  ])("rejects a completed task whose completedTime is %s", async (_label, completedTime) => {
    const client = new DidaCliClient(
      "dida",
      async () => ({
        stdout: JSON.stringify([{ id: "task-1", projectId: "project-1", completedTime }]),
        stderr: ""
      }),
      completedOptions()
    );

    await expect(client.listCompletedTasks(["project-1"])).rejects.toThrow(/completed snapshot/i);
  });

  test("rejects a saturated shard at the CLI's one-second time resolution", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        return {
          stdout: JSON.stringify(
            Array.from({ length: 200 }, (_, index) =>
              completedTask(`task-${index}`, flagValue(args, "--start-date"))
            )
          ),
          stderr: ""
        };
      },
      completedOptions()
    );

    await expect(client.listCompletedTasks(["project-1"])).rejects.toThrow(/one-second|resolution/i);
    expect(calls).toBeGreaterThan(1);
  });

  test("rejects when range-insensitive saturated responses exhaust the query budget", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        return {
          stdout: JSON.stringify(
            Array.from({ length: 200 }, (_, index) =>
              completedTask(`task-${index}`, flagValue(args, "--start-date"))
            )
          ),
          stderr: ""
        };
      },
      completedOptions({ maxCompletedQueries: 2 })
    );

    await expect(client.listCompletedTasks(["project-1"])).rejects.toThrow(/query budget/i);
    expect(calls).toBe(2);
  });

  test("accepts a normalized verified CLI version for completed snapshots", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async () => {
        calls += 1;
        return { stdout: "[]", stderr: "" };
      },
      completedOptions({ cliVersion: "  v0.1.10\n" })
    );

    await expect(client.listCompletedTasks(["project-1"])).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  test("accepts the verified 0.1.14 CLI protocol for both snapshots", async () => {
    const calls: string[][] = [];
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls.push(args);
        return { stdout: "[]", stderr: "" };
      },
      completedOptions({ cliVersion: "0.1.14" })
    );

    await expect(client.listIncompleteTasks(["project-1"])).resolves.toEqual([]);
    await expect(client.listCompletedTasks(["project-1"])).resolves.toEqual([]);
    expect(calls).toEqual([
      ["task", "filter", "--status", "0", "--projects", "project-1", "--json"],
      [
        "task",
        "completed",
        "--start-date",
        "1970-01-01T00:00:00Z",
        "--end-date",
        "9999-12-31T23:59:59Z",
        "--projects",
        "project-1",
        "--json"
      ]
    ]);
  });

  test("enforces the verified 0.1.14 result limit on incomplete snapshots", async () => {
    const client = new DidaCliClient(
      "dida",
      async () => ({
        stdout: JSON.stringify(
          Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, projectId: "project-1" }))
        ),
        stderr: ""
      }),
      completedOptions({ cliVersion: "0.1.14" })
    );

    await expect(client.listIncompleteTasks(["project-1"]))
      .rejects.toThrow(/limit of 200/i);
  });

  test("shards a saturated 0.1.14 completed snapshot instead of trusting 200 rows", async () => {
    let calls = 0;
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        const start = flagValue(args, "--start-date");
        const end = flagValue(args, "--end-date");
        const count = calls === 1 ? 200 : 1;
        return {
          stdout: JSON.stringify(
            Array.from({ length: count }, (_, index) =>
              completedTask(`task-${calls}-${index}`, calls === 1 ? start : end)
            )
          ),
          stderr: ""
        };
      },
      completedOptions({ cliVersion: "0.1.14" })
    );

    const tasks = await client.listCompletedTasks(["project-1"]);

    expect(tasks).toHaveLength(2);
    expect(calls).toBe(3);
  });

  test("lists every verified CLI version when rejecting an unsupported one", async () => {
    const client = new DidaCliClient(
      "dida",
      async () => ({ stdout: "[]", stderr: "" }),
      completedOptions({ cliVersion: "0.1.15" })
    );

    await expect(client.listIncompleteTasks(["project-1"]))
      .rejects.toThrow(/verified versions: 0\.1\.10, 0\.1\.14/);
  });

  test.each([
    undefined,
    "",
    "0.1.9",
    "0.1.11",
    "0.1.13",
    "0.1.15",
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty"
  ])(
    "rejects unsupported CLI version %j before requesting completed tasks",
    async (cliVersion) => {
      let calls = 0;
      const client = new DidaCliClient(
        "dida",
        async () => {
          calls += 1;
          return { stdout: "[]", stderr: "" };
        },
        completedOptions({ cliVersion })
      );

      await expect(client.listCompletedTasks(["project-1"]))
        .rejects.toThrow(/completed snapshot.*unsupported|unsupported.*completed snapshot/i);
      expect(calls).toBe(0);
    }
  );

  test.each([
    ["missing id", { projectId: "project-1", completedTime: "2029-01-01T00:00:00Z" }],
    ["empty id", { id: "  ", projectId: "project-1", completedTime: "2029-01-01T00:00:00Z" }],
    ["missing projectId", { id: "task-2", completedTime: "2029-01-01T00:00:00Z" }],
    ["empty projectId", { id: "task-2", projectId: " ", completedTime: "2029-01-01T00:00:00Z" }],
    ["foreign projectId", { id: "task-2", projectId: "project-2", completedTime: "2029-01-01T00:00:00Z" }]
  ])("rejects an unsafe completed snapshot containing a record with %s", async (_label, unsafeTask) => {
    const client = new DidaCliClient(
      "dida",
      async () => ({
        stdout: JSON.stringify([
          completedTask("valid-task", "2029-01-01T00:00:00Z"),
          unsafeTask
        ]),
        stderr: ""
      }),
      completedOptions()
    );

    await expect(client.listCompletedTasks(["project-1"]))
      .rejects.toThrow(/completed snapshot.*invalid|completed snapshot.*project/i);
  });

  test("rejects when the completed snapshot wall-clock deadline is exhausted", async () => {
    let calls = 0;
    const clockReadings = [1_000, 1_000, 121_001];
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        calls += 1;
        return {
          stdout: JSON.stringify([
            completedTask("task-1", flagValue(args, "--start-date"))
          ]),
          stderr: ""
        };
      },
      completedOptions({
        deadlineNow: () => clockReadings.shift() ?? 121_001,
        completedSnapshotDeadlineMs: 120_000
      })
    );

    await expect(client.listCompletedTasks(["project-1"])).rejects.toThrow(/deadline/i);
    expect(calls).toBe(1);
  });
});

describe("DidaCliGateway", () => {
  test("delegates incomplete task snapshots to the CLI client", async () => {
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        expect(args).toEqual([
          "task",
          "filter",
          "--status",
          "0",
          "--projects",
          "project-1",
          "--json"
        ]);
        return {
          stdout: JSON.stringify([
            { id: "task-1", projectId: "project-1", title: "Task", content: "Source" }
          ]),
          stderr: ""
        };
      },
      completedOptions()
    );
    const gateway = new DidaCliGateway(client);

    await expect(gateway.listIncompleteTasks(["project-1"])).resolves.toEqual([
      { id: "task-1", projectId: "project-1", title: "Task", content: "Source" }
    ]);
  });

  test("delegates completed task snapshots to the CLI client", async () => {
    const client = new DidaCliClient(
      "dida",
      async (_command, args) => {
        expect(args).toEqual([
          "task",
          "completed",
          "--start-date",
          "1970-01-01T00:00:00Z",
          "--end-date",
          "9999-12-31T23:59:59Z",
          "--projects",
          "project-1",
          "--json"
        ]);
        return {
          stdout: JSON.stringify([
            {
              id: "task-1",
              projectId: "project-1",
              title: "Task",
              content: "Source\nSiYuan-Block-ID: block-1",
              completedTime: "2029-12-31T23:59:59Z"
            }
          ]),
          stderr: ""
        };
      },
      completedOptions()
    );
    const gateway = new DidaCliGateway(client);

    await expect(gateway.listCompletedTasks(["project-1"])).resolves.toEqual([
      {
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        content: "Source\nSiYuan-Block-ID: block-1",
        completedTime: "2029-12-31T23:59:59Z"
      }
    ]);
  });
});

describe("DidaCliClient project data", () => {
  test("loads tasks and kanban columns for one Dida list", async () => {
    const client = new DidaCliClient("dida", async (command, args) => {
      expect(command).toBe("dida");
      expect(args).toEqual(["project", "data", "project-1", "--json"]);
      return {
        stdout: JSON.stringify({
          project: { id: "project-1", name: "Courses" },
          tasks: [
            { id: "task-1", projectId: "project-1", title: "Homework", status: 0, columnId: "col-1" }
          ],
          columns: [{ id: "col-1", name: "Later", sortOrder: 1 }]
        }),
        stderr: ""
      };
    });

    await expect(client.getProjectData("project-1")).resolves.toEqual({
      project: { id: "project-1", name: "Courses" },
      tasks: [
        { id: "task-1", projectId: "project-1", title: "Homework", status: 0, columnId: "col-1" }
      ],
      columns: [{ id: "col-1", name: "Later", sortOrder: 1 }]
    });
  });

  test("rejects an invalid project data payload", async () => {
    const client = new DidaCliClient("dida", async () => ({
      stdout: JSON.stringify({ tasks: {} }),
      stderr: ""
    }));

    await expect(client.getProjectData("project-1")).rejects.toThrow(/invalid/i);
  });
});
