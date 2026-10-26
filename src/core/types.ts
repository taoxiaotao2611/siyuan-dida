export interface SyncRange {
  id: string;
  name: string;
  notebookId: string;
  hpathPrefix: string;
  includeChildren: boolean;
  targetProjectId: string;
  targetProjectName: string;
  /** Empty string targets the whole list; otherwise only this kanban column. */
  columnId?: string;
  columnName?: string;
  cursorOffset?: number;
}

export interface SyncSettings {
  maxTasksPerRun: number;
  newTaskDate?: NewTaskDate;
  ranges: SyncRange[];
  /**
   * Epoch-second lower bound for the completed-tasks pull. When present, the
   * engine runs an incremental snapshot from this watermark instead of a full
   * baseline. Absent/0 means full baseline.
   */
  completedWatermarkSecond?: number;
}

export type NewTaskDate = "today" | "none";

export interface SiYuanTodoBlock {
  id: string;
  parentId?: string;
  markdown: string;
  box: string;
  hpath: string;
  attrs: Record<string, string>;
}

export interface SyncResult {
  created: number;
  /** Optional so sync logs persisted before recovery support remain readable. */
  recovered?: number;
  updated: number;
  completed: number;
  writtenBack: number;
  failed: number;
  skipped: number;
  scanned: number;
  rangeResults: SyncRangeResult[];
  rangeCursorOffsets: Record<string, number>;
  events: SyncEvent[];
  failures: Array<{ blockId?: string; message: string }>;
  startedAt: string;
  finishedAt: string;
  /**
   * Next completed-tasks watermark (epoch seconds) after this run, for
   * incremental snapshots. Present when the completed pull succeeded.
   */
  completedWatermarkSecond?: number;
  /** Results of each list-to-document mirror that ran in this sync. */
  docSyncs?: DocSyncSummary[];
  /** Legacy single-target summary; only present in logs written before 1.4.0. */
  docSync?: DocSyncSummary;
}

export interface SyncRangeResult {
  rangeId: string;
  rangeName: string;
  notebookId: string;
  hpathPrefix: string;
  scanned: number;
  created: number;
  /** Optional so sync logs persisted before recovery support remain readable. */
  recovered?: number;
  updated: number;
  completed: number;
  writtenBack: number;
  failed: number;
  skipped: number;
  cursorOffset: number;
  nextCursorOffset: number;
  hasMore: boolean;
}

export interface SyncEvent {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  blockId?: string;
  rangeId?: string;
}

export interface SiYuanGateway {
  listTodoBlocks(
    range: SyncRange,
    limit: number,
    offset?: number,
    recoveryBlockIds?: ReadonlySet<string>
  ): Promise<SiYuanTodoBlock[]>;
  getBlockAttrs(blockId: string): Promise<Record<string, string>>;
  setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void>;
  markBlockCompleted(blockId: string): Promise<void>;
}

export interface CreateDidaTaskOptions {
  content?: string;
  allDay?: boolean;
  startDate?: string;
}

export interface DidaTaskSnapshot {
  id: string;
  projectId: string;
  title?: string;
  content?: string;
  columnId?: string;
  columnName?: string;
}

export interface DidaGateway {
  listIncompleteTasks(projectIds: string[]): Promise<DidaTaskSnapshot[]>;
  listCompletedTasks(projectIds: string[], startSecond?: number): Promise<DidaTaskSnapshot[]>;
  createTask(
    projectId: string,
    title: string,
    options?: CreateDidaTaskOptions
  ): Promise<{ id: string; projectId: string; columnId?: string }>;
  updateTaskTitle(projectId: string, taskId: string, title: string): Promise<void>;
  setTaskParent(projectId: string, taskId: string, parentTaskId: string): Promise<void>;
  completeTask(projectId: string, taskId: string): Promise<void>;
}

export interface DidaProjectColumn {
  id: string;
  name: string;
  sortOrder?: number;
}

export interface DidaProjectTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  status?: number;
  columnId?: string;
  columnName?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: number;
  tags?: string[];
  completedTime?: string;
  sortOrder?: number;
  kind?: string;
}

export interface DidaProjectData {
  project: { id: string; name: string };
  tasks: DidaProjectTask[];
  columns: DidaProjectColumn[];
}

/** Dida list reads used by the list-to-document mirror. */
export interface DidaListGateway {
  getProjectData(projectId: string): Promise<DidaProjectData>;
  /** Returns the task when it still exists (possibly completed), undefined on 404. */
  getTask(projectId: string, taskId: string): Promise<DidaProjectTask | undefined>;
}

/**
 * One Dida list (optionally a single kanban column) mirrored into one SiYuan
 * document. Each selected Dida task is written as exactly one SiYuan block.
 */
export interface DocSyncConfig {
  /** Stable identifier for the settings-panel list entry. */
  id: string;
  enabled: boolean;
  projectId: string;
  projectName: string;
  /** Empty string mirrors the whole list; otherwise only tasks in this column. */
  columnId: string;
  columnName: string;
  notebookId: string;
  /** Target document path (hpath), e.g. "/Dida inbox". Created when missing. */
  hpath: string;
}

export interface DocSyncSummary {
  projectName: string;
  columnName: string;
  documentPath: string;
  tasks: number;
  created: number;
  updated: number;
  /** Blocks newly marked as completed or deleted. */
  archived: number;
  failed: number;
}

export interface SiYuanDocBlock {
  id: string;
  markdown: string;
  taskId: string;
}

/** SiYuan document operations needed by the list-to-document mirror. */
export interface SiYuanDocGateway {
  findDocId(notebookId: string, hpath: string): Promise<string | undefined>;
  createDoc(notebookId: string, hpath: string): Promise<string>;
  listManagedBlocks(docId: string, taskIdAttr: string): Promise<SiYuanDocBlock[]>;
  appendBlock(docId: string, markdown: string): Promise<string>;
  updateBlock(blockId: string, markdown: string): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
  setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void>;
  removeEmptyChildBlocks(docId: string): Promise<void>;
}
