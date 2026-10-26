import type {
  CreateDidaTaskOptions,
  DidaGateway,
  DidaProjectData,
  DidaTaskSnapshot
} from "../core/types";
import { DidaCliClient } from "./cli";

export class DidaCliGateway implements DidaGateway {
  constructor(private readonly client: DidaCliClient) {}

  getProjectData(projectId: string): Promise<DidaProjectData> {
    return this.client.getProjectData(projectId);
  }

  listIncompleteTasks(projectIds: string[]): Promise<DidaTaskSnapshot[]> {
    return this.client.listIncompleteTasks(projectIds);
  }

  listCompletedTasks(projectIds: string[], startSecond?: number): Promise<DidaTaskSnapshot[]> {
    return this.client.listCompletedTasks(projectIds, startSecond);
  }

  createTask(projectId: string, title: string, options?: CreateDidaTaskOptions) {
    return this.client.createTask(projectId, title, options);
  }

  async updateTaskTitle(projectId: string, taskId: string, title: string): Promise<void> {
    await this.client.updateTaskTitle(projectId, taskId, title);
  }

  async setTaskParent(projectId: string, taskId: string, parentTaskId: string): Promise<void> {
    await this.client.setTaskParent(projectId, taskId, parentTaskId);
  }

  completeTask(projectId: string, taskId: string) {
    return this.client.completeTask(projectId, taskId);
  }
}
