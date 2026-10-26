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
