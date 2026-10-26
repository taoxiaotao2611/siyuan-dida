import { afterEach, describe, expect, test, vi } from "vitest";
import { SiYuanDocRepository } from "./docRepository";

interface KernelCall {
  path: string;
  body: Record<string, unknown>;
}

function mockKernel(handler: (call: KernelCall) => unknown): KernelCall[] {
  const calls: KernelCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    const call = {
      path: String(path),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    calls.push(call);
    return new Response(JSON.stringify({ code: 0, data: handler(call) }), { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SiYuanDocRepository", () => {
  test("finds a document by notebook and escaped hpath", async () => {
    const calls = mockKernel(() => [{ id: "doc-1" }]);

    await expect(
      new SiYuanDocRepository().findDocId("box-1", "/It's here")
    ).resolves.toBe("doc-1");

    expect(calls[0].path).toBe("/api/query/sql");
    expect(String(calls[0].body.stmt)).toContain("box = 'box-1'");
    expect(String(calls[0].body.stmt)).toContain("hpath = '/It''s here'");
  });

  test("returns undefined when the target document does not exist", async () => {
    mockKernel(() => null);

    await expect(new SiYuanDocRepository().findDocId("box-1", "/Missing")).resolves.toBeUndefined();
  });

  test("creates a document at the requested path", async () => {
    const calls = mockKernel(() => "doc-1");

    await expect(new SiYuanDocRepository().createDoc("box-1", "/Target")).resolves.toBe("doc-1");

    expect(calls[0]).toMatchObject({
      path: "/api/filetree/createDocWithMd",
      body: { notebook: "box-1", path: "/Target", markdown: "" }
    });
  });

  test("lists managed blocks in document order and parses their task ids", async () => {
    mockKernel((call) => {
      if (call.path === "/api/block/getChildBlocks") {
        return [
          { id: "b1", type: "p", markdown: "one" },
          { id: "unmanaged", type: "p", markdown: "user text" },
          { id: "b2", type: "p", markdown: "two" }
        ];
      }
      return [
        { id: "b2", ial: '{: custom-dida-doc-task-id="t2" id="b2"}' },
        { id: "b1", ial: '{: custom-dida-doc-task-id="t1" id="b1"}' },
        { id: "unmanaged", ial: '{: id="unmanaged"}' }
      ];
    });

    await expect(
      new SiYuanDocRepository().listManagedBlocks("doc-1", "custom-dida-doc-task-id")
    ).resolves.toEqual([
      { id: "b1", markdown: "one", taskId: "t1" },
      { id: "b2", markdown: "two", taskId: "t2" }
    ]);
  });

  test("finds mirrored blocks that SiYuan re-parented under a heading", async () => {
    const calls = mockKernel((call) => {
      if (call.path === "/api/block/getChildBlocks") {
        return [
          { id: "heading", type: "h", markdown: "## Upcoming" },
          { id: "nested", type: "p", markdown: "under heading" }
        ];
      }
      return [{ id: "nested", ial: '{: custom-dida-doc-task-id="t1" id="nested"}' }];
    });

    await expect(
      new SiYuanDocRepository().listManagedBlocks("doc-1", "custom-dida-doc-task-id")
    ).resolves.toEqual([{ id: "nested", markdown: "under heading", taskId: "t1" }]);

    const sqlCall = calls.find((call) => call.path === "/api/query/sql");
    expect(String(sqlCall?.body.stmt)).toContain("root_id = 'doc-1'");
    expect(String(sqlCall?.body.stmt)).not.toContain("parent_id =");
  });

  test("returns no managed blocks when the document has no children", async () => {
    mockKernel(() => []);

    await expect(
      new SiYuanDocRepository().listManagedBlocks("doc-1", "custom-dida-doc-task-id")
    ).resolves.toEqual([]);
  });

  test("extracts the new block id from the append transaction", async () => {
    const calls = mockKernel(() => [
      { doOperations: [{ id: "new-block" }] }
    ]);

    await expect(
      new SiYuanDocRepository().appendBlock("doc-1", "text")
    ).resolves.toBe("new-block");

    expect(calls[0]).toMatchObject({
      path: "/api/block/appendBlock",
      body: { parentID: "doc-1", dataType: "markdown", data: "text" }
    });
  });

  test("throws when a block operation returns no id", async () => {
    mockKernel(() => []);

    await expect(new SiYuanDocRepository().appendBlock("doc-1", "text"))
      .rejects.toThrow(/no block ID/);
  });

  test("updates, deletes, and attributes blocks with the expected payloads", async () => {
    const calls = mockKernel(() => null);
    const repository = new SiYuanDocRepository();

    await repository.updateBlock("b1", "new text");
    await repository.deleteBlock("b1");
    await repository.setBlockAttrs("b1", { "custom-dida-doc-task-id": "t1" });

    expect(calls[0]).toMatchObject({
      path: "/api/block/updateBlock",
      body: { id: "b1", dataType: "markdown", data: "new text" }
    });
    expect(calls[1]).toMatchObject({ path: "/api/block/deleteBlock", body: { id: "b1" } });
    expect(calls[2]).toMatchObject({
      path: "/api/attr/setBlockAttrs",
      body: { id: "b1", attrs: { "custom-dida-doc-task-id": "t1" } }
    });
  });

  test("lists ordered children and inserts a block after a heading", async () => {
    const calls = mockKernel((call) => {
      if (call.path === "/api/block/getChildBlocks") {
        return [
          { id: "h1", type: "h", markdown: "## Upcoming" },
          { id: "p1", type: "p", markdown: "text" }
        ];
      }
      if (call.path === "/api/block/insertBlock") {
        return [{ doOperations: [{ id: "new-block" }] }];
      }
      return null;
    });
    const repository = new SiYuanDocRepository();

    await expect(repository.listChildBlocks("doc-1")).resolves.toEqual([
      { id: "h1", type: "h", subType: undefined, markdown: "## Upcoming" },
      { id: "p1", type: "p", subType: undefined, markdown: "text" }
    ]);
    await expect(repository.insertBlockAfter("h1", "added")).resolves.toBe("new-block");

    const insertCall = calls.find((call) => call.path === "/api/block/insertBlock");
    expect(insertCall?.body).toMatchObject({
      previousID: "h1",
      dataType: "markdown",
      data: "added"
    });
  });

  test("removes only empty paragraph children", async () => {
    const calls = mockKernel((call) => {
      if (call.path === "/api/block/getChildBlocks") {
        return [
          { id: "empty", type: "p", markdown: "" },
          { id: "content", type: "p", markdown: "text" },
          { id: "list", type: "l", markdown: "" }
        ];
      }
      return null;
    });

    await new SiYuanDocRepository().removeEmptyChildBlocks("doc-1");

    const deleted = calls
      .filter((call) => call.path === "/api/block/deleteBlock")
      .map((call) => call.body.id);
    expect(deleted).toEqual(["empty"]);
  });
});
