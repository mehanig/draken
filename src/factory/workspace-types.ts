export interface WorkspaceRun {
  id: string; ref: string; commit: string; status: string; detail: string; createdAt: string;
  workflowId?: string; task?: string; inputs?: Record<string, string>; sessionId?: string;
  modelCalls: number | null; stages: { name: string; status: string }[]; patchBytes: number;
}
export interface WorkspacePage { maxCalls: number; available: boolean; repository: string; locationKey: string; agentAvailable: boolean; runs: WorkspaceRun[] }
