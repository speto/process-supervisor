import {type ChildProcess} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ProcessSupervisorError} from './errors.js';
import {FileProcessOwnershipLease} from './file-process-ownership-lease.js';
import {
  messageOf,
  positiveFinite,
  positiveInteger,
  terminateKnownProcessScope,
} from './lifecycle.js';
import {OwnershipCoordinator} from './ownership-coordinator.js';
import {PosixProcessPlatform} from './platform/posix-process-platform.js';
import {
  cloneSnapshot,
  emptySnapshot,
  identityMatches,
  normalizeRunSpec,
  normalizeSpec,
  snapshotFromRecord,
  startingSnapshot,
  validateSpec,
  type NormalizedProcessSpec,
} from './process-spec.js';
import {
  adoptProcess,
  launchProcess,
  ProcessLaunchFailure,
  pruneDurableLogs,
  readDurableOutputTail,
  releaseRuntime,
  type ProcessLaunchResult,
  type ProcessRuntimeContext,
  type RuntimeProcess,
} from './process-runtime.js';
import {reconcileProcessRecords} from './reconciliation.js';
import {FileProcessRecordStore} from './record-store.js';
import type {
  DurableProcessRecord,
  ManagedProcessOutputEvent,
  ManagedProcessOutputStream,
  ManagedProcessSnapshot,
  ManagedProcessSpec,
  ManagedProcessStateEvent,
  ManagedProcessTransport,
  ProcessExecutionSpec,
  ProcessOwnershipLease,
  ProcessPlatform,
  ProcessRecordStore,
  ProcessRunOptions,
  ProcessRunReason,
  ProcessRunResult,
  ProcessSupervisorOptions,
  ReconciliationResult,
} from './types.js';

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_FORCED_SHUTDOWN_MS = 2_000;
const DEFAULT_GROUP_POLL_MS = 25;
const DEFAULT_MONITOR_POLL_MS = 2_000;
const DEFAULT_LOG_POLL_MS = 250;
const DEFAULT_RETAINED_LOG_LAUNCHES = 3;
const DEFAULT_MAX_DURABLE_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETAINED_SNAPSHOTS = 256;
const DEFAULT_MAX_RUN_OUTPUT_BYTES = 8 * 1024 * 1024;

type RequestedRunTermination = Exclude<ProcessRunReason, 'exited'>;

interface ActiveRun {
  readonly id: string;
  readonly maxOutputBytes: number;
  readonly completion: Promise<ProcessRunResult>;
  readonly resolve: (result: ProcessRunResult) => void;
  readonly reject: (error: unknown) => void;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  outputBytes: number;
  requestedReason: RequestedRunTermination | null;
  timer: NodeJS.Timeout | null;
  outputClosed: Promise<void> | null;
  detachOutput: (() => void) | null;
  settled: boolean;
}

function createActiveRun(id: string, maxOutputBytes: number): ActiveRun {
  let resolve!: (result: ProcessRunResult) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<ProcessRunResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    id,
    maxOutputBytes,
    completion,
    resolve,
    reject,
    stdout: [],
    stderr: [],
    outputBytes: 0,
    requestedReason: null,
    timer: null,
    outputClosed: null,
    detachOutput: null,
    settled: false,
  };
}

export class ProcessSupervisor {
  private readonly recordStore: ProcessRecordStore;
  private readonly ownershipLease: ProcessOwnershipLease | null;
  private readonly platform: ProcessPlatform;
  private readonly gracefulShutdownMs: number;
  private readonly forcedShutdownMs: number;
  private readonly groupPollMs: number;
  private readonly monitorPollMs: number;
  private readonly logPollMs: number;
  private readonly maxRetainedLogLaunches: number;
  private readonly maxDurableLogBytes: number;
  private readonly maxRetainedSnapshots: number;
  private readonly now: () => Date;
  private readonly onState: (event: ManagedProcessStateEvent) => void;
  private readonly onOutput: (event: ManagedProcessOutputEvent) => void;
  private readonly runtimes = new Map<string, RuntimeProcess>();
  private readonly snapshots = new Map<string, ManagedProcessSnapshot>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly coordinator = new OwnershipCoordinator();
  private ownershipAcquisition: Promise<void> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: ProcessSupervisorOptions) {
    if (!isAbsolute(options.stateDirectory)) {
      throw new ProcessSupervisorError('INVALID_SPEC', 'Process supervisor state directory must be an absolute path.');
    }

    const usesDefaultRecordStore = options.recordStore === undefined;
    this.recordStore = options.recordStore ?? new FileProcessRecordStore(options.stateDirectory);
    if (!usesDefaultRecordStore && options.ownershipLease === undefined) {
      throw new ProcessSupervisorError(
        'INVALID_SPEC',
        'A custom process record store requires an explicit ownershipLease, or ownershipLease: null when cross-process exclusion is intentionally handled elsewhere.',
      );
    }
    this.ownershipLease = options.ownershipLease === undefined
      ? new FileProcessOwnershipLease(options.stateDirectory)
      : options.ownershipLease;
    this.platform = options.platform ?? new PosixProcessPlatform();
    this.gracefulShutdownMs = positiveFinite(options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS, 'Graceful shutdown timeout');
    this.forcedShutdownMs = positiveFinite(options.forcedShutdownMs ?? DEFAULT_FORCED_SHUTDOWN_MS, 'Forced shutdown timeout');
    this.groupPollMs = positiveFinite(options.groupPollMs ?? DEFAULT_GROUP_POLL_MS, 'Process scope poll interval');
    this.monitorPollMs = positiveFinite(options.monitorPollMs ?? DEFAULT_MONITOR_POLL_MS, 'Process monitor poll interval');
    this.logPollMs = positiveFinite(options.logPollMs ?? DEFAULT_LOG_POLL_MS, 'Log poll interval');
    this.maxRetainedLogLaunches = positiveInteger(options.maxRetainedLogLaunches ?? DEFAULT_RETAINED_LOG_LAUNCHES, 'Retained log launch limit');
    this.maxDurableLogBytes = positiveInteger(options.maxDurableLogBytes ?? DEFAULT_MAX_DURABLE_LOG_BYTES, 'Durable log byte limit');
    this.maxRetainedSnapshots = positiveInteger(options.maxRetainedSnapshots ?? DEFAULT_RETAINED_SNAPSHOTS, 'Retained snapshot limit');
    this.now = options.now ?? (() => new Date());
    this.onState = options.onState ?? (() => {});
    this.onOutput = options.onOutput ?? (() => {});
  }

  getSnapshot(processId: string): ManagedProcessSnapshot | null {
    const snapshot = this.snapshots.get(processId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  listSnapshots(): readonly ManagedProcessSnapshot[] {
    return [...this.snapshots.values()].map(cloneSnapshot);
  }

  forget(processId: string): boolean {
    if (this.runtimes.has(processId)) {
      throw new ProcessSupervisorError('PROCESS_ALREADY_MANAGED', `Cannot forget process ${processId} while ownership is active.`);
    }
    return this.snapshots.delete(processId);
  }

  getTransport(processId: string): ManagedProcessTransport {
    this.assertOpen();
    if (this.activeRuns.has(processId)) {
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Finite process ${processId} owns its stdout/stderr capture and does not expose raw pipe transport.`);
    }
    const runtime = this.runtimes.get(processId);
    if (!runtime?.transport) {
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} does not expose raw pipe transport.`);
    }
    return runtime.transport;
  }

  start(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.runOwned(() => this.startLocked(normalizeSpec(spec)));
  }

  restart(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.runOwned(async () => {
      const normalized = normalizeSpec(spec);
      if (this.runtimes.has(normalized.id)) await this.stopLocked(normalized.id);
      return this.startLocked(normalized);
    });
  }

  run(spec: ProcessExecutionSpec, options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    this.assertOpen();
    const normalized = normalizeRunSpec(spec);
    const timeoutMs = options.timeoutMs === undefined
      ? null
      : positiveInteger(options.timeoutMs, 'Run timeout');
    const maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_RUN_OUTPUT_BYTES,
      'Run output byte limit',
    );
    const active = createActiveRun(normalized.id, maxOutputBytes);
    return this.runFiniteProcess(normalized, active, timeoutMs);
  }

  stop(processId: string): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.runOwned(() => this.stopLocked(processId));
  }

  reconcile(): Promise<ReconciliationResult> {
    this.assertOpen();
    return this.runOwned(() => reconcileProcessRecords({
      recordStore: this.recordStore,
      platform: this.platform,
      isAlreadyManaged: (processId) => this.runtimes.has(processId),
      terminate: (record) => this.terminateVerifiedRecord(record),
      adopt: async (record) => {
        const runtime = await adoptProcess(record, this.runtimeContext());
        this.runtimes.set(record.id, runtime);
        this.publish(snapshotFromRecord(record, 'running', 'adopted', null));
        this.scheduleMonitor();
      },
      onRecordRemoved: (record) => this.pruneRecordLogs(record),
      publish: (snapshot) => this.publish(snapshot),
    }));
  }

  async readOutputTail(
    processId: string,
    stream: ManagedProcessOutputStream,
    maxBytes = 64 * 1024,
  ): Promise<string> {
    const runtime = this.runtimes.get(processId);
    if (!runtime?.record.logs) {
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} has no durable output.`);
    }
    return readDurableOutputTail(runtime, stream, maxBytes);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.coordinator.close(() => this.closeLocked());
  }

  private async closeLocked(): Promise<void> {
    if (this.closed) return;
    this.clearMonitor();

    const preserved: RuntimeProcess[] = [];
    const errors: unknown[] = [];
    for (const processId of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(processId);
      if (!runtime) continue;
      if (runtime.record.shutdownPolicy === 'preserve') {
        preserved.push(runtime);
        continue;
      }
      try {
        await this.stopLocked(processId);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      this.scheduleMonitor();
      throw new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop ${errors.length} managed process${errors.length === 1 ? '' : 'es'} during close. Remaining ownership was retained for retry.`,
        {cause: new AggregateError(errors)},
      );
    }

    try {
      await this.releaseOwnership();
    } catch (error) {
      this.scheduleMonitor();
      throw error;
    }

    for (const runtime of preserved) {
      if (this.runtimes.get(runtime.record.id) !== runtime) continue;
      releaseRuntime(runtime);
      this.runtimes.delete(runtime.record.id);
    }
    this.closed = true;
  }

  private async startLocked(spec: NormalizedProcessSpec): Promise<ManagedProcessSnapshot> {
    const launched = await this.launchManagedLocked(spec);
    if (launched.kind === 'exited') {
      const detail = launched.code !== null
        ? ` with code ${launched.code}`
        : launched.signal ? ` from ${launched.signal}` : '';
      const crashed: ManagedProcessSnapshot = {
        ...snapshotFromRecord(launched.record, 'crashed', null, null),
        lastExitCode: launched.code,
        lastSignal: launched.signal,
        error: `Managed process exited before becoming stable${detail}.`,
      };
      this.publish(crashed);
      throw new ProcessSupervisorError(
        'PROCESS_START_FAILED',
        `Failed to start process ${spec.id}: managed process exited before becoming stable${detail}.`,
      );
    }
    return this.getSnapshot(spec.id)!;
  }

  private async runFiniteProcess(
    spec: NormalizedProcessSpec,
    active: ActiveRun,
    timeoutMs: number | null,
  ): Promise<ProcessRunResult> {
    try {
      await this.runOwned(() => this.startRunLocked(spec, active, timeoutMs));
    } catch (error) {
      this.disposeActiveRun(active);
      throw error;
    }
    return active.completion;
  }

  private async startRunLocked(
    spec: NormalizedProcessSpec,
    active: ActiveRun,
    timeoutMs: number | null,
  ): Promise<void> {
    if (this.activeRuns.has(spec.id)) {
      throw new ProcessSupervisorError('PROCESS_ALREADY_MANAGED', `Process ${spec.id} is already managed.`);
    }
    this.activeRuns.set(spec.id, active);
    try {
      const launched = await this.launchManagedLocked(
        spec,
        (child) => this.attachRunOutput(active, child, timeoutMs),
      );
      if (launched.kind === 'exited') {
        const stopped: ManagedProcessSnapshot = {
          ...snapshotFromRecord(launched.record, 'stopped', null, null),
          lastExitCode: launched.code,
          lastSignal: launched.signal,
        };
        this.publish(stopped);
        await this.finishActiveRun(
          active,
          active.requestedReason ?? 'exited',
          launched.code,
          launched.signal,
          false,
        );
      }
    } catch (error) {
      this.disposeActiveRun(active);
      throw error;
    }
  }

  private async launchManagedLocked(
    spec: NormalizedProcessSpec,
    onSpawned?: (child: ChildProcess) => void,
  ): Promise<ProcessLaunchResult> {
    if (this.runtimes.has(spec.id)) {
      throw new ProcessSupervisorError('PROCESS_ALREADY_MANAGED', `Process ${spec.id} is already managed.`);
    }

    const persisted = await this.recordStore.get(spec.id);
    if (persisted?.kind === 'valid') {
      throw new ProcessSupervisorError(
        'PROCESS_ALREADY_MANAGED',
        `Process ${spec.id} already has durable ownership state. Reconcile it before starting a replacement.`,
      );
    }
    if (persisted?.kind === 'invalid') {
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Process ${spec.id} has an invalid durable ownership record: ${persisted.error}`,
      );
    }

    await validateSpec(spec);
    this.publish(startingSnapshot(spec));
    try {
      const launched = await launchProcess(
        spec,
        this.runtimeContext(),
        {
          onExit: (child, code, signal) => {
            void this.coordinator.runInternal(() => this.handleChildExitLocked(spec.id, child, code, signal));
          },
          ...(onSpawned ? {onSpawned} : {}),
        },
      );
      if (launched.kind === 'running') {
        this.runtimes.set(spec.id, launched.runtime);
        this.publish(snapshotFromRecord(launched.runtime.record, 'running', 'started', null));
      }
      return launched;
    } catch (error) {
      if (error instanceof ProcessLaunchFailure && error.residualRuntime) {
        const runtime = error.residualRuntime;
        this.runtimes.set(spec.id, runtime);
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', 'started', null),
          error: `Launch failed and residual cleanup failed. Ownership was retained${error.recordPersisted ? '' : ' in memory only'}: ${messageOf(error.cleanupError)}`,
        });
        throw new ProcessSupervisorError(
          'PROCESS_START_FAILED',
          `Failed to start process ${spec.id}; residual ownership is retained for explicit cleanup.`,
          {cause: error},
        );
      }

      this.publish({
        ...startingSnapshot(spec),
        state: error instanceof ProcessLaunchFailure ? 'unresolved' : 'crashed',
        error: error instanceof ProcessLaunchFailure
          ? `Failed to start managed process and cleanup could not be proven: ${messageOf(error.cleanupError)}`
          : `Failed to start managed process: ${messageOf(error)}`,
      });
      throw new ProcessSupervisorError(
        'PROCESS_START_FAILED',
        `Failed to start process ${spec.id}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  private async stopLocked(processId: string): Promise<ManagedProcessSnapshot> {
    const runtime = this.runtimes.get(processId);
    if (!runtime) {
      const existing = this.snapshots.get(processId);
      if (existing?.state === 'stopped') return cloneSnapshot(existing);
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} is not managed.`);
    }

    const current = this.snapshotFor(runtime);
    if (
      runtime.child
      && current.state !== 'unresolved'
      && (runtime.child.exitCode !== null || runtime.child.signalCode !== null)
    ) {
      return this.handleChildExitLocked(
        processId,
        runtime.child,
        runtime.child.exitCode,
        runtime.child.signalCode,
      );
    }

    const activeRun = this.activeRuns.get(processId);
    if (activeRun && activeRun.requestedReason === null) activeRun.requestedReason = 'stopped';
    runtime.expectedStop = true;
    this.publish({...current, state: 'stopping', error: null, forcedTermination: false});

    try {
      let forced = false;
      const probes = await this.platform.probeMany([runtime.record.pid]);
      const probe = probes.get(runtime.record.pid);
      if (!probe) {
        if (await this.platform.isScopeAlive(runtime.record.scope)) {
          this.publish(this.uncontrolledSnapshot(
            runtime.record,
            'Recorded leader PID is no longer observable while its process scope remains alive. The scope was not signalled and ownership was retained.',
          ));
          throw new ProcessSupervisorError(
            'PROCESS_CONTROL_UNCERTAIN',
            `Process ${processId} no longer has a verifiable leader identity.`,
          );
        }
      } else if (!identityMatches(runtime.record, probe)) {
        await this.handleUnsafeIdentityLocked(runtime, 'Live PID no longer matches the recorded stable process identity.');
        throw new ProcessSupervisorError(
          'PROCESS_IDENTITY_MISMATCH',
          `Process ${processId} no longer matches its recorded identity.`,
        );
      } else {
        forced = await terminateKnownProcessScope(
          this.platform,
          runtime.record.scope,
          this.gracefulShutdownMs,
          this.forcedShutdownMs,
          this.groupPollMs,
        );
      }

      await this.recordStore.remove(processId);
      releaseRuntime(runtime);
      this.runtimes.delete(processId);
      await this.pruneRecordLogs(runtime.record);
      const previous = this.snapshots.get(processId);
      const stopped: ManagedProcessSnapshot = {
        ...snapshotFromRecord(runtime.record, 'stopped', null, null),
        lastExitCode: previous?.lastExitCode ?? null,
        lastSignal: previous?.lastSignal ?? null,
        forcedTermination: forced,
      };
      this.publish(stopped);
      if (activeRun) {
        await this.finishActiveRun(
          activeRun,
          activeRun.requestedReason ?? 'stopped',
          runtime.child?.exitCode ?? null,
          runtime.child?.signalCode ?? null,
          forced,
        );
      }
      return cloneSnapshot(stopped);
    } catch (error) {
      runtime.expectedStop = false;
      if (
        error instanceof ProcessSupervisorError
        && (error.code === 'PROCESS_IDENTITY_MISMATCH' || error.code === 'PROCESS_CONTROL_UNCERTAIN')
      ) {
        if (activeRun) this.failActiveRun(activeRun, error);
        throw error;
      }
      if (this.runtimes.get(processId) === runtime) {
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', runtime.child ? 'started' : 'adopted', null),
          lastExitCode: current.lastExitCode,
          lastSignal: current.lastSignal,
          error: `Failed to stop managed process; ownership was retained for retry: ${messageOf(error)}`,
        });
      }
      const failure = new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop process ${processId}: ${messageOf(error)}`,
        {cause: error},
      );
      if (activeRun) this.failActiveRun(activeRun, failure);
      throw failure;
    }
  }

  private async handleChildExitLocked(
    processId: string,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<ManagedProcessSnapshot> {
    const runtime = this.runtimes.get(processId);
    if (!runtime || runtime.child !== child) {
      return this.getSnapshot(processId) ?? emptySnapshot(processId);
    }

    const current = this.snapshotFor(runtime);
    const activeRun = this.activeRuns.get(processId);
    if (activeRun) return this.handleRunExitLocked(runtime, activeRun, code, signal);
    if (runtime.expectedStop || current.state === 'stopping') return current;

    const detail = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : '';
    let scopeAlive;
    try {
      scopeAlive = await this.platform.isScopeAlive(runtime.record.scope);
    } catch (error) {
      const unresolved = {
        ...this.uncontrolledSnapshot(
          runtime.record,
          `Managed process leader exited unexpectedly${detail}; process-scope liveness could not be established, so ownership was retained: ${messageOf(error)}`,
        ),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      return cloneSnapshot(unresolved);
    }

    if (scopeAlive) {
      const unresolved = {
        ...this.uncontrolledSnapshot(
          runtime.record,
          `Managed process leader exited unexpectedly${detail} while its recorded scope remains alive. Ownership was retained without signalling the now-unproven scope.`,
        ),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      return cloneSnapshot(unresolved);
    }

    try {
      await this.recordStore.remove(processId);
    } catch (error) {
      const unresolved = {
        ...this.uncontrolledSnapshot(
          runtime.record,
          `Managed process exited unexpectedly${detail}; its process scope is dead but durable ownership could not be cleared: ${messageOf(error)}`,
        ),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      return cloneSnapshot(unresolved);
    }

    releaseRuntime(runtime);
    this.runtimes.delete(processId);
    await this.pruneRecordLogs(runtime.record);
    const crashed = {
      ...this.snapshotForRecordWithExit(runtime.record, code, signal),
      error: `Managed process exited unexpectedly${detail}.`,
    };
    this.publish(crashed);
    return cloneSnapshot(crashed);
  }

  private async handleRunExitLocked(
    runtime: RuntimeProcess,
    active: ActiveRun,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<ManagedProcessSnapshot> {
    let scopeAlive: boolean;
    try {
      scopeAlive = await this.platform.isScopeAlive(runtime.record.scope);
    } catch (error) {
      const message = `Finite process exited but process-scope liveness could not be established. Ownership was retained: ${messageOf(error)}`;
      const unresolved = {
        ...this.uncontrolledSnapshot(runtime.record, message),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      this.failActiveRun(
        active,
        new ProcessSupervisorError('PROCESS_CONTROL_UNCERTAIN', message, {cause: error}),
      );
      return cloneSnapshot(unresolved);
    }

    if (scopeAlive) {
      const message = 'Finite process leader exited while its recorded process scope remains alive. Ownership was retained without signalling the now-unproven scope.';
      const unresolved = {
        ...this.uncontrolledSnapshot(runtime.record, message),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      this.failActiveRun(
        active,
        new ProcessSupervisorError('PROCESS_CONTROL_UNCERTAIN', message),
      );
      return cloneSnapshot(unresolved);
    }

    try {
      await this.recordStore.remove(runtime.record.id);
    } catch (error) {
      const message = `Finite process exited but durable ownership could not be cleared: ${messageOf(error)}`;
      const unresolved = {
        ...this.uncontrolledSnapshot(runtime.record, message),
        lastExitCode: code,
        lastSignal: signal,
      };
      this.publish(unresolved);
      this.failActiveRun(active, error);
      return cloneSnapshot(unresolved);
    }

    releaseRuntime(runtime);
    this.runtimes.delete(runtime.record.id);
    await this.pruneRecordLogs(runtime.record);
    const stopped: ManagedProcessSnapshot = {
      ...snapshotFromRecord(runtime.record, 'stopped', null, null),
      lastExitCode: code,
      lastSignal: signal,
    };
    this.publish(stopped);
    await this.finishActiveRun(
      active,
      active.requestedReason ?? 'exited',
      code,
      signal,
      false,
    );
    return cloneSnapshot(stopped);
  }

  private attachRunOutput(active: ActiveRun, child: ChildProcess, timeoutMs: number | null): void {
    if (!child.stdout || !child.stderr) {
      throw new Error('Finite process did not expose stdout/stderr pipes.');
    }

    const onStdout = (chunk: Buffer | string) => this.captureRunOutput(active, 'stdout', chunk);
    const onStderr = (chunk: Buffer | string) => this.captureRunOutput(active, 'stderr', chunk);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    let resolveClosed!: () => void;
    const onClose = () => resolveClosed();
    active.outputClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    child.once('close', onClose);
    if (child.stdout.closed && child.stderr.closed) resolveClosed();
    active.detachOutput = () => {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('close', onClose);
    };

    if (timeoutMs !== null) {
      active.timer = setTimeout(
        () => this.requestRunTermination(active.id, 'timed_out'),
        timeoutMs,
      );
      active.timer.unref();
    }
  }

  private captureRunOutput(
    active: ActiveRun,
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string,
  ): void {
    if (active.settled || active.requestedReason === 'output_limit') return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, active.maxOutputBytes - active.outputBytes);
    const accepted = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
    if (accepted.length > 0) {
      active[stream].push(Buffer.from(accepted));
      active.outputBytes += accepted.length;
    }
    if (bytes.length > remaining) this.requestRunTermination(active.id, 'output_limit');
  }

  private requestRunTermination(processId: string, reason: RequestedRunTermination): void {
    const active = this.activeRuns.get(processId);
    if (!active || active.settled || active.requestedReason !== null) return;
    active.requestedReason = reason;
    void this.coordinator.runInternal(async () => {
      if (active.settled || !this.runtimes.has(processId)) return;
      try {
        await this.stopLocked(processId);
      } catch (error) {
        this.failActiveRun(active, error);
      }
    });
  }

  private async finishActiveRun(
    active: ActiveRun,
    reason: ProcessRunReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    forcedTermination: boolean,
  ): Promise<void> {
    if (active.settled) return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    if (active.outputClosed) await active.outputClosed;
    if (active.settled) return;
    active.settled = true;
    active.detachOutput?.();
    active.detachOutput = null;
    this.activeRuns.delete(active.id);
    active.resolve({
      reason,
      exitCode,
      signal,
      stdout: Buffer.concat(active.stdout).toString('utf8'),
      stderr: Buffer.concat(active.stderr).toString('utf8'),
      forcedTermination,
    });
  }

  private failActiveRun(active: ActiveRun, error: unknown): void {
    if (active.settled) return;
    active.settled = true;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active.detachOutput?.();
    active.detachOutput = null;
    this.activeRuns.delete(active.id);
    active.reject(error);
  }

  private disposeActiveRun(active: ActiveRun): void {
    if (active.settled) return;
    active.settled = true;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active.detachOutput?.();
    active.detachOutput = null;
    this.activeRuns.delete(active.id);
  }

  private scheduleMonitor(): void {
    if (this.monitorTimer || this.closed || !this.hasAdoptedRuntimes()) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      void this.coordinator.runInternal(() => this.monitorAdoptedBatchLocked());
    }, this.monitorPollMs);
    this.monitorTimer.unref();
  }

  private clearMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async monitorAdoptedBatchLocked(): Promise<void> {
    if (this.closed) return;
    const runtimes = [...this.runtimes.values()].filter((runtime) => runtime.child === null);
    if (runtimes.length === 0) return;

    let probes;
    try {
      probes = await this.platform.probeMany(runtimes.map((runtime) => runtime.record.pid));
    } catch (error) {
      for (const runtime of runtimes) {
        if (this.runtimes.get(runtime.record.id) !== runtime) continue;
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', 'adopted', null),
          error: `Process inspection failed; ownership was retained: ${messageOf(error)}`,
        });
      }
      this.scheduleMonitor();
      return;
    }

    for (const runtime of runtimes) {
      if (this.runtimes.get(runtime.record.id) !== runtime) continue;
      const probe = probes.get(runtime.record.pid);
      if (!probe) {
        await this.handleAdoptedLeaderMissingLocked(runtime);
        continue;
      }

      if (!identityMatches(runtime.record, probe)) {
        await this.handleUnsafeIdentityLocked(
          runtime,
          'Adopted PID now belongs to a different stable process identity.',
        );
        continue;
      }

      const snapshot = this.snapshots.get(runtime.record.id);
      if (snapshot?.state !== 'running' || snapshot.error) {
        this.publish(snapshotFromRecord(runtime.record, 'running', 'adopted', null));
      }
    }

    this.scheduleMonitor();
  }

  private async handleAdoptedLeaderMissingLocked(runtime: RuntimeProcess): Promise<void> {
    let scopeAlive;
    try {
      scopeAlive = await this.platform.isScopeAlive(runtime.record.scope);
    } catch (error) {
      this.publish(this.uncontrolledSnapshot(
        runtime.record,
        `Adopted leader PID is gone and process-scope liveness could not be established. Ownership was retained: ${messageOf(error)}`,
      ));
      return;
    }

    if (scopeAlive) {
      this.publish(this.uncontrolledSnapshot(
        runtime.record,
        'Adopted leader PID exited while the recorded process scope remains alive. Ownership was retained without signalling the unproven scope.',
      ));
      return;
    }

    try {
      await this.recordStore.remove(runtime.record.id);
    } catch (error) {
      this.publish(this.uncontrolledSnapshot(
        runtime.record,
        `Adopted process scope exited, but durable ownership could not be cleared: ${messageOf(error)}`,
      ));
      return;
    }

    releaseRuntime(runtime);
    this.runtimes.delete(runtime.record.id);
    await this.pruneRecordLogs(runtime.record);
    this.publish({
      ...snapshotFromRecord(runtime.record, 'crashed', null, null),
      error: 'Adopted process exited after recovery.',
    });
  }

  private async handleUnsafeIdentityLocked(runtime: RuntimeProcess, reason: string): Promise<void> {
    let scopeAlive;
    try {
      scopeAlive = await this.platform.isScopeAlive(runtime.record.scope);
    } catch (error) {
      this.publish(this.uncontrolledSnapshot(
        runtime.record,
        `${reason} Process-scope liveness could not be established, so ownership was retained: ${messageOf(error)}`,
      ));
      return;
    }

    if (scopeAlive) {
      this.publish(this.uncontrolledSnapshot(
        runtime.record,
        `${reason} The recorded scope remains alive and can no longer be proven safe to signal, so ownership was retained.`,
      ));
      return;
    }

    let removalError: unknown | null = null;
    try {
      await this.recordStore.remove(runtime.record.id);
    } catch (error) {
      removalError = error;
    }

    if (!removalError) {
      releaseRuntime(runtime);
      this.runtimes.delete(runtime.record.id);
      await this.pruneRecordLogs(runtime.record);
    }
    this.publish(this.uncontrolledSnapshot(
      runtime.record,
      removalError ? `${reason} Durable ownership cleanup failed: ${messageOf(removalError)}` : reason,
    ));
  }

  private async terminateVerifiedRecord(record: DurableProcessRecord): Promise<void> {
    const probes = await this.platform.probeMany([record.pid]);
    const probe = probes.get(record.pid);
    if (!probe) {
      if (await this.platform.isScopeAlive(record.scope)) {
        throw new ProcessSupervisorError(
          'PROCESS_CONTROL_UNCERTAIN',
          `Process ${record.id} no longer has a verifiable leader identity while its recorded scope remains alive.`,
        );
      }
      return;
    }
    if (!identityMatches(record, probe)) {
      throw new ProcessSupervisorError(
        'PROCESS_IDENTITY_MISMATCH',
        `Process ${record.id} no longer matches its recorded identity.`,
      );
    }
    await terminateKnownProcessScope(
      this.platform,
      record.scope,
      this.gracefulShutdownMs,
      this.forcedShutdownMs,
      this.groupPollMs,
    );
  }

  private runtimeContext(): ProcessRuntimeContext {
    return {
      stateDirectory: this.options.stateDirectory,
      recordStore: this.recordStore,
      platform: this.platform,
      gracefulShutdownMs: this.gracefulShutdownMs,
      forcedShutdownMs: this.forcedShutdownMs,
      groupPollMs: this.groupPollMs,
      logPollMs: this.logPollMs,
      maxRetainedLogLaunches: this.maxRetainedLogLaunches,
      maxDurableLogBytes: this.maxDurableLogBytes,
      now: this.now,
      onOutput: this.onOutput,
    };
  }

  private snapshotFor(runtime: RuntimeProcess): ManagedProcessSnapshot {
    return this.getSnapshot(runtime.record.id)
      ?? snapshotFromRecord(runtime.record, 'running', runtime.child ? 'started' : 'adopted', null);
  }

  private snapshotForRecordWithExit(
    record: DurableProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): ManagedProcessSnapshot {
    return {
      ...snapshotFromRecord(record, 'crashed', null, null),
      lastExitCode: code,
      lastSignal: signal,
    };
  }

  private uncontrolledSnapshot(record: DurableProcessRecord, error: string): ManagedProcessSnapshot {
    return {
      ...snapshotFromRecord(record, 'unresolved', null, error),
      pid: null,
      scope: null,
      startedAt: null,
    };
  }

  private publish(snapshot: ManagedProcessSnapshot): void {
    const copy = cloneSnapshot(snapshot);
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, copy);
    this.evictSnapshots();
    try {
      this.onState({processId: snapshot.id, snapshot: cloneSnapshot(copy)});
    } catch {
      // Observers must not destabilize process supervision.
    }
  }

  private evictSnapshots(): void {
    while (this.snapshots.size > this.maxRetainedSnapshots) {
      const candidate = [...this.snapshots.entries()].find(([processId, snapshot]) => {
        if (this.runtimes.has(processId)) return false;
        return snapshot.state !== 'starting' && snapshot.state !== 'running' && snapshot.state !== 'stopping';
      });
      if (!candidate) return;
      this.snapshots.delete(candidate[0]);
    }
  }

  private async pruneRecordLogs(record: DurableProcessRecord): Promise<void> {
    if (!record.logs) return;
    await pruneDurableLogs(this.options.stateDirectory, record.id, this.maxRetainedLogLaunches).catch(() => undefined);
  }

  private hasAdoptedRuntimes(): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.child === null);
  }

  private runOwned<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator.run(async () => {
      await this.ensureOwnership();
      return operation();
    });
  }

  private async ensureOwnership(): Promise<void> {
    if (!this.ownershipLease) return;
    this.ownershipAcquisition ??= this.ownershipLease.acquire().catch((error) => {
      this.ownershipAcquisition = null;
      throw error;
    });
    await this.ownershipAcquisition;
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.ownershipLease || !this.ownershipAcquisition) return;
    await this.ownershipAcquisition;
    await this.ownershipLease.release();
    this.ownershipAcquisition = null;
  }

  private assertOpen(): void {
    if (this.closed || !this.coordinator.isAccepting) {
      throw new ProcessSupervisorError('SUPERVISOR_CLOSED', 'Process supervisor is closed or closing.');
    }
  }
}
