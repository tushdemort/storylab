export type AttemptStage =
  | "attention"
  | "waiting"
  | "instruction"
  | "chat"
  | "finalizing"
  | "quiz"
  | "complete"
  | "aborted";

export type QuizOption = { value: string; label: string };
export type QuizQuestion = { id: string; prompt: string; options: QuizOption[] };
export type CollaborationPhase = "ideation" | "discussion" | "outline" | "writing";

export type StudyConfig = {
  id: string;
  version: number;
  consentMarkdown: string;
  keystrokeDisclosure: string;
  attentionPrompt: string;
  instructionMarkdown: string;
  ideationInstructionMarkdown: string;
  ideationPrompt: string;
  discussionInstructionMarkdown: string;
  discussionPrompt: string;
  outlineInstructionMarkdown: string;
  outlinePrompt: string;
  writingInstructionMarkdown: string;
  writingPrompt: string;
  waitSeconds: number;
  chatSeconds: number;
  ideationSeconds: number;
  discussionSeconds: number;
  outlineSeconds: number;
  writingSeconds: number;
  reconnectSeconds: number;
  quizQuestions: QuizQuestion[];
};

export type Attempt = {
  id: string;
  stage: AttemptStage;
  pairSessionId: string | null;
  attentionResponse: string | null;
  startedAt: string;
  completedAt: string | null;
  lastSeenAt: string;
};

export type QueueState = {
  status: "waiting" | "expired";
  joinedAt: string;
  expiresAt: string;
} | null;

export type PairMember = {
  attemptId: string;
  alias: string;
  readyAt: string | null;
  lastSeenAt: string;
  isSelf: boolean;
};

export type PairState = {
  id: string;
  status: "instruction" | "chat" | "finalizing" | "approved" | "complete" | "aborted";
  pairedAt: string;
  chatStartedAt: string | null;
  chatEndsAt: string | null;
  phase: CollaborationPhase;
  phaseStartedAt: string;
  phaseEndsAt: string | null;
  sharedOutline: string;
  sharedOutlineUpdatedAt: string | null;
  sharedOutlineUpdatedBy: string | null;
  disconnectedAttemptId: string | null;
  disconnectDetectedAt: string | null;
  finalStory: string | null;
  members: PairMember[];
} | null;

export type PhaseApproval = {
  phase: Exclude<CollaborationPhase, "writing">;
  attemptId: string;
  decidedAt: string;
};

export type ChatMessage = {
  id: string;
  senderAttemptId: string;
  clientMessageId: string;
  fieldInstanceId: string;
  body: string;
  createdAt: string;
};

export type OutlineInsertRun = {
  id: string;
  afterId: string | null;
  text: string;
};

export type OutlineOperation = {
  id: string;
  insertRuns: OutlineInsertRun[];
  deleteIds: string[];
};

export type OutlineOperationBatch = {
  clientBatchId: string;
  senderAttemptId: string;
  operations: OutlineOperation[];
  createdAt: string;
};

export type StoryApproval = {
  attemptId: string;
  decision: "agree" | "disagree";
  decidedAt: string;
};

export type StoryProposal = {
  id: string;
  proposerAttemptId: string;
  version: number;
  body: string;
  fieldInstanceId: string;
  status: "pending" | "rejected" | "accepted";
  createdAt: string;
  approvals: StoryApproval[];
} | null;

export type ParticipantState = {
  attempt: Attempt;
  config: StudyConfig;
  queue: QueueState;
  pair: PairState;
  messages: ChatMessage[];
  outlineOperationBatches: OutlineOperationBatch[];
  phaseApprovals: PhaseApproval[];
  ideationDraft: string;
  proposal: StoryProposal;
  quizResponses: Record<string, string>;
  serverNow: string;
};

export type KeystrokeEventKind =
  | "keydown"
  | "beforeinput"
  | "input"
  | "paste"
  | "compositionstart"
  | "compositionupdate"
  | "compositionend";

export type KeystrokeEventRecord = {
  attemptId: string;
  pairSessionId: string;
  fieldType: "chat" | "story";
  fieldInstanceId: string;
  clientEventId: string;
  clientSequence: number;
  correlationId: string | null;
  eventKind: KeystrokeEventKind;
  keyValue: string | null;
  codeValue: string | null;
  inputType: string | null;
  eventData: string | null;
  clientWallTime: string;
  clientElapsedMs: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionStartAfter: number | null;
  selectionEndAfter: number | null;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isRepeat: boolean;
  keyLocation: number;
  isComposing: boolean;
};

export type ApiError = { error: string };
