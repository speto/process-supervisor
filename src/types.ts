export type ManagedProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed';

export type ManagedProcessOrigin = 'started' | 'adopted';
export type ManagedProcessOutputStream = 'stdout' | 'stderr';
export type ProcessIoMode = 'pipe' | 'durable-log';
export type ProcessRecoveryPolicy = 'terminate' | 'adopt';
export type ProcessShutdownPolicy = 'terminate' | 'preserve';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {readonly [key: string]: JsonValue};

export interface ProcessEnvironmentPolicy {
  inherit?: readonly string[];
  inheritPath?: boolean;
  prependExecutableDirectoryToPath?: boolean;
  values?: Readonly<Record<string, string>>;
}

export interface ManagedProcessSpec {
  id: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  ioMode?: ProcessIoMode;
  recoveryPolicy?: ProcessRecoveryPolicy;
  shutdownPolicy?: ProcessShutdownPolicy;
  environment?: ProcessEnvironmentPolicy;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ProcessIdentity {
  startedAt: string;
  commandFingerprint: string;
}

export interface ProcessInspection {
  pid: number;
  processGroupId: number;
  startedAt: string;
  commandLine: string;
}

export interface DurableProcessLogs {
  stdoutPath: string;
  stderrPath: string;
}

export interface DurableProcessRecord {
  schemaVersion: 1;
  id: string;
  pid: number;
  processGroupId: number;
  executable: string;
  cwd: string;
  ioMode: ProcessIoMode;
  recoveryPolicy: ProcessRecoveryPolicy;
  shutdownPolicy: ProcessShutdownPolicy;
  identity: ProcessIdentity;
  logs?: DurableProcessLogs;
  createdAt: string;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface ManagedProcessSnapshot {
  id: string;
  state: ManagedProcessState;
  origin: ManagedProcessOrigin | null;
  pid: number | null;
  processGroupId: number | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastSignal: NodeJS.Signals | null;
  error: string | null;
  forcedTermination: boolean;
  ioMode: ProcessIoMode | null;
  recoveryPolicy: ProcessRecoveryPolicy | null;
  shutdownPolicy: ProcessShutdownPolicy | null;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface ManagedProcessOutputEvent {
  processId: string;
  stream: ManagedProcessOutputStream;
  line: string;
}

export interface ManagedProcessStateEvent {
  processId: string;
  snapshot: ManagedProcessSnapshot;
}

export type ProcessRecordEntry =
  | {kind: 'valid'; record: DurableProcessRecord}
  | {kind: 'invalid'; filePath: string; error: string};

export interface ProcessRecordStore {
  get(processId: string): Promise<ProcessRecordEntry | null>;
  list(): Promise<readonly ProcessRecordEntry[]>;
  save(record: DurableProcessRecord): Promise<void>;
  remove(processId: string): Promise<void>;
}

export interface ProcessPlatform {
  inspect(pid: number): Promise<ProcessInspection | null>;
  isProcessGroupAlive(processGroupId: number): Promise<boolean>;
  signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void>;
}

export interface ReconciliationIssue {
  processId: string | null;
  code: 'invalid_record' | 'inspection_failed' | 'termination_failed' | 'adoption_failed';
  message: string;
}

export interface ReconciliationResult {
  checked: number;
  dead: number;
  stale: number;
  adopted: number;
  terminated: number;
  unresolved: number;
  invalid: number;
  issues: readonly ReconciliationIssue[];
}

export interface ProcessSupervisorOptions {
  stateDirectory: string;
  recordStore?: ProcessRecordStore;
  platform?: ProcessPlatform;
  gracefulShutdownMs?: number;
  forcedShutdownMs?: number;
  groupPollMs?: number;
  monitorPollMs?: number;
  logPollMs?: number;
  now?: () => Date;
  onState?: (event: ManagedProcessStateEvent) => void;
  onOutput?: (event: ManagedProcessOutputEvent) => void;
}
