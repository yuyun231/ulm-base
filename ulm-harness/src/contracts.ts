/**
 * ULM Harness shared contracts.
 *
 * P3/P4/P5 agents implement against this file. DO NOT modify this file in a
 * phase task. If a contract is wrong, fail the task and report it in the
 * handoff document; the integration agent will reconcile.
 *
 * These types intentionally have no OpenClaw imports so P3 and P5 can be
 * built and tested without loading the OpenClaw plugin runtime.
 */

// ---------------------------------------------------------------------------
// Identity / wake payload (mirrors ULM base control channel wake payload)
// ---------------------------------------------------------------------------

export interface UlmAgentIdentity {
  agentId: string;
  role: string;
  capabilities: string[];
}

export interface UlmTaskSnapshot {
  taskId: string;
  taskType: string;
  goal: string | null;
  acceptanceCriteria: string | null;
  dagVersion: number;
  parentTaskId: string | null;
  dialogueId: string | null;
  workspaceId: string | null;
  /** Node to submit for this task. Mandatory after base-side P0. */
  nodeId?: string | null;
}

export interface UlmDialogueDirective {
  dialogueId: string | null;
  mode: "new" | "continue";
}

export interface UlmGuidanceItem {
  guidanceId: string;
  content: string;
  type: "now" | "future";
}

export interface UlmPermissionItem {
  ruleId?: string;
  subject: string;
  action: string;
  object: string;
  effect: "allow" | "deny" | "require-approval";
}

export interface UlmWakePayload {
  taskId: string;
  task: UlmTaskSnapshot;
  dialogue: UlmDialogueDirective;
  guidance: UlmGuidanceItem[];
  permissions: UlmPermissionItem[];
  workspace: { workspaceId: string | null };
}

// ---------------------------------------------------------------------------
// Control channel commands / acks
// ---------------------------------------------------------------------------

export type UlmControlCommandName =
  | "wake"
  | "sleep"
  | "interrupt"
  | "reorder"
  | "redo"
  | "correct"
  | "modelConfig"
  | "whitelist"
  | "agentDef"
  | "judgeResult"
  | "inject";

export interface UlmControlCommand {
  commandId: string;
  command: UlmControlCommandName;
  agentId: string;
  taskId?: string;
  purposeId?: string;
  payload: Record<string, unknown>;
}

export interface UlmControlAck {
  commandId: string;
  agentId: string;
  success: boolean;
  detail?: string;
  result?: unknown;
  taskId?: string;
  purposeId?: string;
}

// ---------------------------------------------------------------------------
// Event / service channel (ULM base side)
// ---------------------------------------------------------------------------

export type UlmEventFamily =
  | "organ"
  | "task"
  | "schedule"
  | "comm"
  | "dialogue"
  | "admin"
  | "doc";

export interface UlmEventInput {
  family: UlmEventFamily;
  subtype: string;
  handles: Record<string, string | undefined>;
  payload: Record<string, unknown>;
  /** Defaults to the registered agent identity when omitted. */
  agentId?: string;
}

export type UlmServiceEndpoint =
  | "read"
  | "consultInitiate"
  | "reportIssue"
  | "submitMaterial"
  | "judgeRequest"
  | "dialoguePost"
  | "publishTask";

export interface UlmServiceResponse {
  ok: boolean;
  seq?: number;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * P5 implements this. It owns the WebSocket connection to the ULM base and
 * translates base frames into the command/event/service contracts above.
 */
export interface UlmBasePort {
  connect(identity: UlmAgentIdentity): Promise<void>;
  close(): Promise<void>;

  /** Returns an unsubscribe function. */
  onCommand(handler: (cmd: UlmControlCommand) => void | Promise<void>): () => void;

  sendAck(ack: UlmControlAck): void | Promise<void>;
  emitEvent(event: UlmEventInput): void | Promise<void>;
  request(
    endpoint: UlmServiceEndpoint,
    args: Record<string, unknown>,
  ): Promise<UlmServiceResponse>;
}

/**
 * P4 implements this. It starts an OpenClaw turn for a ULM wake and exposes
 * live control over the running turn without translating ULM semantics into
 * Gateway chat commands.
 */
export interface UlmTurnStarter {
  startTurn(wake: UlmWakePayload, identity: UlmAgentIdentity): Promise<UlmStartTurnResult>;
  abortTurn(runId: string, reason?: string): Promise<void>;
  steerTurn(runId: string, text: string): Promise<void>;
  injectTurn(runId: string, text: string): Promise<void>;
}

export interface UlmStartTurnResult {
  runId: string;
  sessionKey: string;
  status: "started" | "queued" | "rejected";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Controlled loop (P3)
// ---------------------------------------------------------------------------

export interface UlmModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface UlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface UlmModelTurn {
  text: string;
  toolCalls: UlmToolCall[];
  raw?: unknown;
}

export interface UlmModelCallOptions {
  model?: string;
  thinking?: string;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface UlmModelPort {
  call(
    messages: UlmModelMessage[],
    options?: UlmModelCallOptions,
  ): Promise<UlmModelTurn>;
}

export interface UlmToolDescriptor {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface UlmToolResult {
  content: string;
  isError: boolean;
  raw?: unknown;
}

export interface UlmToolPort {
  list(): UlmToolDescriptor[];
  execute(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<UlmToolResult>;
}

export interface UlmLoopPorts {
  model: UlmModelPort;
  tools: UlmToolPort;
  base: Pick<UlmBasePort, "emitEvent" | "request">;
}

export type UlmRunState =
  | "idle"
  | "running"
  | "waitingJudge"
  | "done"
  | "aborted"
  | "error";

export interface UlmRunInput {
  runId: string;
  wake: UlmWakePayload;
  /** Base dialogueId if a continued conversation must be injected. */
  dialogueText?: string;
}

export interface UlmRunResult {
  state: "done" | "aborted" | "error";
  finalText: string;
  material?: string;
  error?: string;
}

/**
 * A running task handle. P4 keeps one handle per active run and routes
 * interrupt/correct/redo/inject/sleep into it.
 */
export interface UlmRunHandle {
  readonly runId: string;
  readonly wake: UlmWakePayload;
  state(): UlmRunState;
  wait(): Promise<UlmRunResult>;
  interrupt(reason?: string): Promise<void>;
  correct(text: string): Promise<void>;
  inject(text: string): Promise<void>;
  redo(): Promise<void>;
  applyModelConfig(config: Record<string, unknown>): void;
  applyWhitelist(toolNames: string[]): void;
  applyAgentDef(def: Record<string, unknown>): void;
  sleep(): Promise<void>;
}

/**
 * P3 implements this as a deterministic orchestration engine. It must not
 * import OpenClaw or the ULM WebSocket client.
 */
export interface UlmControlledLoop {
  run(input: UlmRunInput, ports: UlmLoopPorts): Promise<UlmRunResult>;
  createHandle(input: UlmRunInput, ports: UlmLoopPorts): UlmRunHandle;
}

// ---------------------------------------------------------------------------
// Harness-level command dispatcher glue (P4 owns, P5 calls)
// ---------------------------------------------------------------------------

/**
 * P4 implements this facade. P5's base link calls it for each incoming ULM
 * command. The facade owns wake-context storage, turn starting, active run
 * handles, and judge execution.
 */
export interface UlmHarnessCommandFacade {
  handleCommand(
    cmd: UlmControlCommand,
    base: UlmBasePort,
  ): Promise<UlmControlAck>;
}
