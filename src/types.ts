import type {ChildProcess, StdioOptions} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';

export type ManagedProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'unresolved';

export type ManagedProcessOrigin = 'started' | 'adopted';
export type ManagedProcessOutputStream = 'stdout' | 'stderr';
export type ProcessIoMode = 'line' | 'pipe' | 'durable-log';
export type ProcessRecoveryPolicy = 'terminate' | 'adopt';
export type ProcessShutdownPolicy = 'terminate' | 'preserve';
export type ProcessTerminationMode = 'graceful' | 'force';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {readonly [key: string]: JsonValue};

export interface ProcessEnvironmentPolicy {
  inherit?: readonly string[];
  inheritPath?: boolean;
  prependExecutableDirectoryToPath?: boolean;
  values?: Readonly<Record<string, string>>;
}

export interface ProcessExecutionSpec {
  id: string;
  executable: string;
  args: readonly string[];
  argv0?: string;
  cwd: string;
  environment?: ProcessEnvironmentPolicy;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ManagedProcessSpec extends ProcessExecutionSpec {
  ioMode?: ProcessIoMode;
  recoveryPolicy?: ProcessRecoveryPolicy;
  shutdownPolicy?: ProcessShutdownPolicy;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type ProcessRunReason = 'exited' | 'stopped' | 'timed_out' | 'output_limit';

export interface ProcessRunResult {
  reason: ProcessRunReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  forcedTermination: boolean;
}

export interface ProcessScope {
  kind: string;
  id: string;
}

export interface ProcessIdentity {
  startedAt: string | null;
  stableId: string | null;
  commandFingerprint?: string;
}

export interface ProcessProbe {
  pid: number;
  scope: ProcessScope;
  stableId: string;
}

export interface ProcessInspection extends ProcessProbe {
  startedAt: string;
  commandLine: string;
}

export interface ProcessSpawnRequest {
  executable: string;
  args: readonly string[];
  argv0?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export interface ManagedProcessTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export interface DurableProcessLogs {
  launchId: string;
}

export interface DurableProcessRecord {
  schemaVersion: 3;
  id: string;
  pid: number;
  scope: ProcessScope;
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
  scope: ProcessScope | null;
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

export interface ProcessOwnershipLease {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface ProcessPlatform {
  spawn(request: ProcessSpawnRequest): ChildProcess;
  scopeForSpawnedProcess(pid: number): ProcessScope;
  inspect(pid: number): Promise<ProcessInspection | null>;
  probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>>;
  isScopeAlive(scope: ProcessScope): Promise<boolean>;
  terminateScope(scope: ProcessScope, mode: ProcessTerminationMode): Promise<void>;
}

export interface ReconciliationIssue {
  processId: string | null;
  code:
    | 'invalid_record'
    | 'inspection_failed'
    | 'identity_unavailable'
    | 'scope_identity_unavailable'
    | 'termination_failed'
    | 'adoption_failed';
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
  ownershipLease?: ProcessOwnershipLease | null;
  platform?: ProcessPlatform;
  gracefulShutdownMs?: number;
  forcedShutdownMs?: number;
  groupPollMs?: number;
  monitorPollMs?: number;
  logPollMs?: number;
  maxRetainedLogLaunches?: number;
  maxDurableLogBytes?: number;
  maxRetainedSnapshots?: number;
  now?: () => Date;
  onState?: (event: ManagedProcessStateEvent) => void;
  onOutput?: (event: ManagedProcessOutputEvent) => void;
}
