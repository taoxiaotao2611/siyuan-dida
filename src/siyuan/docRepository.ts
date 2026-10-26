import type { SiYuanDocBlock, SiYuanDocGateway } from "../core/types";
import { kernelApi } from "./api";

interface ChildBlock {
  id: string;
  type?: string;
  subType?: string;
  markdown?: string;
}

interface SqlRow {
  id: string;
  ial?: string;
}

interface TransactionResult {
  doOperations?: Array<{ id?: string }>;
}

/**
 * Kernel API adapter for the Dida -> SiYuan document mirror.
 *
 * Block ids are discovered from the API responses rather than assumed:
 * appendBlock/insertBlock return transaction payloads whose first doOperation
 * carries the new block id.
 */
export class SiYuanDocRepository implements SiYuanDocGateway {
  async findDocId(notebookId: string, hpath: string): Promise<string | undefined> {
    const rows = await kernelApi<SqlRow[] | null>("/api/query/sql", {
      stmt: `SELECT id FROM blocks
        WHERE type = 'd' AND box = '${escapeSql(notebookId)}' AND hpath = '${escapeSql(hpath)}'
        LIMIT 1`
    });
    return rows?.[0]?.id;
  }

  async createDoc(notebookId: string, hpath: string): Promise<string> {
    return kernelApi<string>("/api/filetree/createDocWithMd", {
      notebook: notebookId,
      path: hpath,
      markdown: ""
    });
  }

  async listManagedBlocks(docId: string, taskIdAttr: string): Promise<SiYuanDocBlock[]> {
    const children = (await kernelApi<ChildBlock[] | null>("/api/block/getChildBlocks", {
      id: docId
    })) ?? [];
    if (children.length === 0) {
      return [];
    }

    const rows = (await kernelApi<SqlRow[] | null>("/api/query/sql", {
      stmt: `SELECT id, ial FROM blocks
        WHERE parent_id = '${escapeSql(docId)}' AND ial LIKE '%${escapeSql(taskIdAttr)}%'`
    })) ?? [];
    const ialById = new Map(rows.map((row) => [row.id, row.ial ?? ""]));
    const attrPattern = new RegExp(`(?:^|[{;\\s])${escapeRegExp(taskIdAttr)}="([^"]*)"`);

    return children.flatMap((child) => {
      const ial = ialById.get(child.id);
      if (ial === undefined) {
        return [];
      }
      const match = ial.match(attrPattern);
      const taskId = match?.[1] ?? "";
      if (!taskId) {
        return [];
      }
      return [{ id: child.id, markdown: child.markdown ?? "", taskId }];
    });
  }

  async appendBlock(docId: string, markdown: string): Promise<string> {
    const data = await kernelApi<TransactionResult[] | null>("/api/block/appendBlock", {
      parentID: docId,
      dataType: "markdown",
      data: markdown
    });
    return firstBlockId(data);
  }

  async updateBlock(blockId: string, markdown: string): Promise<void> {
    await kernelApi<unknown>("/api/block/updateBlock", {
      id: blockId,
      dataType: "markdown",
      data: markdown
    });
  }

  async deleteBlock(blockId: string): Promise<void> {
    await kernelApi<unknown>("/api/block/deleteBlock", { id: blockId });
  }

  async setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void> {
    await kernelApi<unknown>("/api/attr/setBlockAttrs", { id: blockId, attrs });
  }

  async removeEmptyChildBlocks(docId: string): Promise<void> {
    const children = (await kernelApi<ChildBlock[] | null>("/api/block/getChildBlocks", {
      id: docId
    })) ?? [];
    for (const child of children) {
      if (child.type === "p" && !(child.markdown ?? "").trim()) {
        await this.deleteBlock(child.id);
      }
    }
  }
}

function firstBlockId(data: TransactionResult[] | null): string {
  const blockId = data
    ?.flatMap((transaction) => transaction.doOperations ?? [])
    .map((operation) => operation.id)
    .find((id): id is string => typeof id === "string" && id.length > 0);
  if (!blockId) {
    throw new Error("SiYuan block operation returned no block ID");
  }
  return blockId;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
