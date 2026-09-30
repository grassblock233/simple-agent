export type ImageRef = { id: string; name: string; mime: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "user"; content: string; images?: ImageRef[] }
  | { role: "assistant"; content: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ReasoningEffort = "off" | "low" | "high" | "max";
export type SessionSettings = { reasoningEffort: ReasoningEffort; maxAttempts: number; compression: boolean; threshold: number };
export type AppSettings = { sessionDefaults: SessionSettings };
export type Event = {
  id: string;
  at: string;
  type: "user" | "reasoning" | "answer" | "tool" | "compression" | "error" | "notice";
  text?: string;
  images?: ImageRef[];
  name?: string;
  args?: string;
  result?: string;
  status?: "pending" | "success" | "failed" | "denied";
  durationMs?: number;
  approvalId?: string;
  range?: string;
};
export type Session = {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  settings: SessionSettings;
  messages: ChatMessage[];
  contextStart: number;
  summary: string;
  events: Event[];
  pinned: boolean;
  archived: boolean;
};
export type Project = {
  workspace: string;
  name: string;
  pinned: boolean;
  hidden: boolean;
};
export type DirectorySelectionResult = { status: "selected"; path: string } | { status: "cancelled" | "unavailable" };
export type ProjectCreationResult = { project: Project; session: Session };
export type LiveEvent = { type: "event"; event: Event } | { type: "status"; status: string; occupancy?: number } | { type: "delta"; field: "answer" | "reasoning"; text: string } | { type: "done" };
