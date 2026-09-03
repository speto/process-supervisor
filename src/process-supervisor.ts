import {type ChildProcess} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ProcessSupervisorError} from './errors.js';
import {
  messageOf,
  positiveFinite,
  terminateKnownProcessGroup,
} from './lifecycle.js';
import {PosixProcessPlatform} from './platform/posix-process-platform.js';
import {
  cloneSnapshot,
  emptySnapshot,
  identityMatches,
  normalizeSpec,
  snapshotFromRecord,
  startingSnapshot,
  validateSpec,
  type NormalizedProcessSpec,
} from './process-spec.js';
import {
  adoptProcess,
  launchProcess,
  readDurableOutputTail,
  releaseRuntime,
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
  ProcessPlatform,
  ProcessRecordStore,
  ProcessSupervisorOptions,
  ManagedProcessStateEvent,
  ReconciliationResult,
} from './types.js';

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_FORCED_SHUTDOWN_MS = 2_000;
const DEFAULT_GROUP_POLL_MS = 25;
const DEFAULT_MONITOR_POLL_MS = 1_000;
const DEFAULT_LOG_POLL_MS = 100;

export class ProcessSupervisor {
  private readonly recordStore: ProcessRecordStore;
  private readonly platform: ProcessPlatform;
  private readonly gracefulShutdownMs: number;
  private readonly forcedShutdownMs: number;
  private readonly groupPollMs: number;
  private readonly monitorPollMs: number;
  private readonly logPollMs: number;
  private readonly now: () => Date;
  private readonly onState: (event: ManagedProcessStateEvent) => void;
  private readonly onOutput: (event: ManagedProcessOutputEvent) => void;
  private readonly runtimes = new Map<string, RuntimeProcess>();
  private readonly snapshots = new Map<string, ManagedProcessSnapshot>();
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: ProcessSupervisorOptions) {
    if (!isAbsolute(options.stateDirectory)) {
      throw new ProcessSupervisorError('INVALID_SPEC', 'Process supervisor state directory must be an absolute path.');
    }
    this.recordStore = options.recordStore ?? new FileProcessRecordStore(options.stateDirectory);
    this.platform = options.platform ?? new PosixProcessPlatform();
    this.gracefulShutdownMs = positiveFinite(options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS, 'Graceful shutdown timeout');
    this.forcedShutdownMs = positiveFinite(options.forcedShutdownMs ?? DEFAULT_FORCED_SHUTDOWN_MS, 'Forced shutdown timeout');
    this.groupPollMs = positiveFinite(options.groupPollMs ?? DEFAULT_GROUP_POLL_MS, 'Process group poll interval');
    this.monitorPollMs = positiveFinite(options.monitorPollMs ?? DEFAULT_MONITOR_POLL_MS, 'Process monitor poll interval');
    this.logPollMs = positiveFinite(options.logPollMs ?? DEFAULT_LOG_POLL_MS, 'Log poll interval');
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

  start(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.enqueue(spec.id, () => this.startLocked(normalizeSpec(spec)));
  }

  restart(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.enqueue(spec.id, async () => {
      const normalized = normalizeSpec(spec);
      if (this.runtimes.has(normalized.id)) await this.stopLocked(normalized.id);
      return this.startLocked(normalized);
    });
  }

  stop(processId: string): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.enqueue(processId, () => this.stopLocked(processId));
  }

  async reconcile(): Promise<ReconciliationResult> {
    this.assertOpen();
    return reconcileProcessRecords({
      recordStore: this.recordStore,
      platform: this.platform,
      isAlreadyManaged: (processId) => this.runtimes.has(processId),
      terminate: (record) => this.terminateVerifiedRecord(record),
      adopt: async (record) => {
        const runtime = await adoptProcess(record, this.runtimeContext());
        this.runtimes.set(record.id, runtime);
        this.publish(snapshotFromRecord(record, 'running', 'adopted', null));
        this.scheduleMonitor(runtime);
      },
      publish: (snapshot) => this.publish(snapshot),
    });
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
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Lifecycle operations accepted before close() must settle before ownership is released.
    await Promise.allSettled([...this.lifecycleQueues.values()]);

    const errors: unknown[] = [];
    for (const processId of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(processId);
      if (!runtime) continue;
      if (runtime.record.shutdownPolicy === 'preserve') {
        releaseRuntime(runtime);
        this.runtimes.delete(processId);
        continue;
      }
      try {
        await this.enqueue(processId, () => this.stopLocked(processId));
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop ${errors.length} managed process${errors.length === 1 ? '' : 'es'} during close.`,
        {cause: new AggregateError(errors)},
      );
    }
  }

  private async startLocked(spec: NormalizedProcessSpec): Promise<ManagedProcessSnapshot> {
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
      const runtime = await launchProcess(
        spec,
        this.runtimeContext(),
        (child, code, signal) => {
          void this.enqueue(spec.id, () => this.handleChildExitLocked(spec.id, child, code, signal));
        },
      );
      this.runtimes.set(spec.id, runtime);
      this.publish(snapshotFromRecord(runtime.record, 'running', 'started', null));
      return this.getSnapshot(spec.id)!;
    } catch (error) {
      this.runtimes.delete(spec.id);
      this.publish({
        ...startingSnapshot(spec),
        state: 'crashed',
        error: `Failed to start managed process: ${messageOf(error)}`,
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

    if (runtime.child && (runtime.child.exitCode !== null || runtime.child.signalCode !== null)) {
      return this.handleChildExitLocked(
        processId,
        runtime.child,
        runtime.child.exitCode,
        runtime.child.signalCode,
      );
    }

    runtime.expectedStop = true;
    this.publish({...this.snapshotFor(runtime), state: 'stopping', error: null, forcedTermination: false});

    try {
      let forced = false;
      if (runtime.child) {
        forced = await terminateKnownProcessGroup(
          this.platform,
          runtime.record.processGroupId,
          this.gracefulShutdownMs,
          this.forcedShutdownMs,
          this.groupPollMs,
        );
      } else {
        const inspection = await this.platform.inspect(runtime.record.pid);
        if (inspection && !identityMatches(runtime.record, inspection)) {
          await this.recordStore.remove(processId);
          releaseRuntime(runtime);
          this.runtimes.delete(processId);
          const snapshot = {
            ...snapshotFromRecord(runtime.record, 'crashed', null, null),
            error: 'Live PID no longer matches the recorded process identity. Ownership was discarded without signalling it.',
          };
          this.publish(snapshot);
          throw new ProcessSupervisorError(
            'PROCESS_IDENTITY_MISMATCH',
            `Process ${processId} no longer matches its recorded identity.`,
          );
        }

        if (inspection) {
          forced = await terminateKnownProcessGroup(
            this.platform,
            runtime.record.processGroupId,
            this.gracefulShutdownMs,
            this.forcedShutdownMs,
            this.groupPollMs,
          );
        }
      }

      await this.recordStore.remove(processId);
      releaseRuntime(runtime);
      this.runtimes.delete(processId);
      const previous = this.snapshots.get(processId);
      const stopped: ManagedProcessSnapshot = {
        ...snapshotFromRecord(runtime.record, 'stopped', null, null),
        lastExitCode: previous?.lastExitCode ?? null,
        lastSignal: previous?.lastSignal ?? null,
        forcedTermination: forced,
      };
      this.publish(stopped);
      return cloneSnapshot(stopped);
    } catch (error) {
      runtime.expectedStop = false;
      if (error instanceof ProcessSupervisorError && error.code === 'PROCESS_IDENTITY_MISMATCH') throw error;
      this.publish({
        ...this.snapshotFor(runtime),
        state: 'crashed',
        error: `Failed to stop managed process: ${messageOf(error)}`,
      });
      throw new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop process ${processId}: ${messageOf(error)}`,
        {cause: error},
      );
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
    if (runtime.expectedStop || current.state === 'stopping') return current;

    const detail = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : '';
    this.publish({
      ...this.snapshotFor(runtime),
      state: 'crashed',
      pid: null,
      startedAt: null,
      lastExitCode: code,
      lastSignal: signal,
      error: `Managed process exited unexpectedly${detail}.`,
    });

    await terminateKnownProcessGroup(
      this.platform,
      runtime.record.processGroupId,
      this.gracefulShutdownMs,
      this.forcedShutdownMs,
      this.groupPollMs,
    ).catch(() => undefined);
    await this.recordStore.remove(processId).catch(() => undefined);
    releaseRuntime(runtime);
    this.runtimes.delete(processId);
    const crashed = {
      ...this.snapshotForRecordWithExit(runtime.record, code, signal),
      processGroupId: null,
      error: `Managed process exited unexpectedly${detail}.`,
    };
    this.publish(crashed);
    return cloneSnapshot(crashed);
  }

  private scheduleMonitor(runtime: RuntimeProcess): void {
    if (runtime.child || runtime.monitorTimer || this.closed) return;
    runtime.monitorTimer = setTimeout(() => {
      runtime.monitorTimer = null;
      void this.monitorAdopted(runtime);
    }, this.monitorPollMs);
    runtime.monitorTimer.unref();
  }

  private async monitorAdopted(runtime: RuntimeProcess): Promise<void> {
    if (this.runtimes.get(runtime.record.id) !== runtime || this.closed) return;
    try {
      const inspection = await this.platform.inspect(runtime.record.pid);
      if (inspection === null) {
        await this.enqueue(runtime.record.id, async () => {
          if (this.runtimes.get(runtime.record.id) !== runtime) return this.snapshotFor(runtime);
          await this.recordStore.remove(runtime.record.id).catch(() => undefined);
          releaseRuntime(runtime);
          this.runtimes.delete(runtime.record.id);
          const crashed = {
            ...snapshotFromRecord(runtime.record, 'crashed', null, null),
            error: 'Adopted process exited after recovery.',
          };
          this.publish(crashed);
          return crashed;
        });
        return;
      }

      if (!identityMatches(runtime.record, inspection)) {
        await this.enqueue(runtime.record.id, async () => {
          if (this.runtimes.get(runtime.record.id) !== runtime) return this.snapshotFor(runtime);
          await this.recordStore.remove(runtime.record.id).catch(() => undefined);
          releaseRuntime(runtime);
          this.runtimes.delete(runtime.record.id);
          const crashed = {
            ...snapshotFromRecord(runtime.record, 'crashed', null, null),
            error: 'Adopted PID no longer matches the recorded process identity. Ownership was discarded without signalling it.',
          };
          this.publish(crashed);
          return crashed;
        });
        return;
      }

      const snapshot = this.snapshots.get(runtime.record.id);
      if (snapshot?.error) this.publish({...snapshot, error: null});
    } catch (error) {
      const snapshot = this.snapshots.get(runtime.record.id);
      if (snapshot?.state === 'running') {
        this.publish({...snapshot, error: `Process inspection failed: ${messageOf(error)}`});
      }
    } finally {
      if (this.runtimes.get(runtime.record.id) === runtime) this.scheduleMonitor(runtime);
    }
  }

  private async terminateVerifiedRecord(record: DurableProcessRecord): Promise<void> {
    const inspection = await this.platform.inspect(record.pid);
    if (!inspection) return;
    if (!identityMatches(record, inspection)) {
      throw new ProcessSupervisorError(
        'PROCESS_IDENTITY_MISMATCH',
        `Process ${record.id} no longer matches its recorded identity.`,
      );
    }
    await terminateKnownProcessGroup(
      this.platform,
      record.processGroupId,
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
      now: this.now,
      onOutput: this.onOutput,
    };
  }

  private snapshotFor(runtime: RuntimeProcess): ManagedProcessSnapshot {
    return this.getSnapshot(runtime.record.id) ?? snapshotFromRecord(runtime.record, 'running', runtime.child ? 'started' : 'adopted', null);
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

  private publish(snapshot: ManagedProcessSnapshot): void {
    const copy = cloneSnapshot(snapshot);
    this.snapshots.set(snapshot.id, copy);
    try {
      this.onState({processId: snapshot.id, snapshot: cloneSnapshot(copy)});
    } catch {
      // Observers must not destabilize process supervision.
    }
  }

  private enqueue<T>(processId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(processId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.lifecycleQueues.set(processId, settled);
    void settled.finally(() => {
      if (this.lifecycleQueues.get(processId) === settled) this.lifecycleQueues.delete(processId);
    });
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new ProcessSupervisorError('PROCESS_STOP_FAILED', 'Process supervisor is closed.');
  }
}
