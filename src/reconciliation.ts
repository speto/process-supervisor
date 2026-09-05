import {messageOf} from './lifecycle.js';
import {identityMatches, snapshotFromRecord} from './process-spec.js';
import type {
  DurableProcessRecord,
  ManagedProcessSnapshot,
  ProcessPlatform,
  ProcessRecordStore,
  ReconciliationIssue,
  ReconciliationResult,
} from './types.js';

export interface ReconciliationContext {
  recordStore: ProcessRecordStore;
  platform: ProcessPlatform;
  isAlreadyManaged(processId: string): boolean;
  terminate(record: DurableProcessRecord): Promise<void>;
  adopt(record: DurableProcessRecord): Promise<void>;
  onRecordRemoved(record: DurableProcessRecord): Promise<void>;
  publish(snapshot: ManagedProcessSnapshot): void;
}

export async function reconcileProcessRecords(
  context: ReconciliationContext,
): Promise<ReconciliationResult> {
  const entries = await context.recordStore.list();
  const issues: ReconciliationIssue[] = [];
  const records: DurableProcessRecord[] = [];
  let dead = 0;
  let stale = 0;
  let adopted = 0;
  let terminated = 0;
  let unresolved = 0;
  let invalid = 0;

  for (const entry of entries) {
    if (entry.kind === 'invalid') {
      invalid += 1;
      issues.push({
        processId: null,
        code: 'invalid_record',
        message: `${entry.filePath}: ${entry.error}`,
      });
      continue;
    }
    if (!context.isAlreadyManaged(entry.record.id)) records.push(entry.record);
  }

  const checked = records.length;
  let probes;
  try {
    probes = await context.platform.probeMany(records.map((record) => record.pid));
  } catch (error) {
    unresolved = records.length;
    for (const record of records) {
      issues.push({processId: record.id, code: 'inspection_failed', message: messageOf(error)});
    }
    return {checked, dead, stale, adopted, terminated, unresolved, invalid, issues};
  }

  for (const record of records) {
    if (record.identity.stableId === null) {
      const scopeState = await inspectScopeState(context, record, issues);
      if (scopeState === 'dead') {
        dead += 1;
        await removeRecord(context, record);
        context.publish(snapshotFromRecord(record, 'stopped', null, null));
      } else {
        unresolved += 1;
        issues.push({
          processId: record.id,
          code: 'identity_unavailable',
          message: 'Durable ownership was persisted before stable process identity capture completed.',
        });
        context.publish(uncontrolledSnapshot(
          record,
          scopeState === 'alive'
            ? 'Stable process identity was never captured and the recorded scope remains alive. Ownership was retained without signalling it.'
            : 'Stable process identity was never captured and process-scope liveness could not be established. Ownership was retained.',
        ));
      }
      continue;
    }

    const probe = probes.get(record.pid);
    if (!probe) {
      const scopeState = await inspectScopeState(context, record, issues);
      if (scopeState === 'dead') {
        dead += 1;
        await removeRecord(context, record);
        context.publish(snapshotFromRecord(record, 'stopped', null, null));
      } else {
        unresolved += 1;
        context.publish(uncontrolledSnapshot(
          record,
          scopeState === 'alive'
            ? 'Recorded leader PID is gone but the recorded process scope is still alive. Ownership was retained without signalling the unproven scope.'
            : 'Recorded leader PID is gone and process-scope liveness could not be established. Ownership was retained.',
        ));
      }
      continue;
    }

    if (!identityMatches(record, probe)) {
      stale += 1;
      const scopeState = await inspectScopeState(context, record, issues);
      if (scopeState === 'dead') {
        await removeRecord(context, record);
        context.publish(uncontrolledSnapshot(
          record,
          'Recorded PID belongs to a different process identity and the original process scope is no longer alive. Durable ownership was discarded without signalling anything.',
        ));
      } else {
        unresolved += 1;
        context.publish(uncontrolledSnapshot(
          record,
          scopeState === 'alive'
            ? 'Recorded PID belongs to a different process identity while the recorded scope remains alive. Ownership was retained because the scope can no longer be proven safe to signal.'
            : 'Recorded PID belongs to a different process identity and process-scope liveness could not be established. Ownership was retained.',
        ));
      }
      continue;
    }

    if (record.recoveryPolicy === 'terminate') {
      try {
        await context.terminate(record);
        terminated += 1;
        await removeRecord(context, record);
        context.publish(snapshotFromRecord(record, 'stopped', null, null));
      } catch (error) {
        unresolved += 1;
        issues.push({processId: record.id, code: 'termination_failed', message: messageOf(error)});
      }
      continue;
    }

    try {
      await context.adopt(record);
      adopted += 1;
    } catch (error) {
      unresolved += 1;
      issues.push({processId: record.id, code: 'adoption_failed', message: messageOf(error)});
    }
  }

  return {checked, dead, stale, adopted, terminated, unresolved, invalid, issues};
}

async function inspectScopeState(
  context: ReconciliationContext,
  record: DurableProcessRecord,
  issues: ReconciliationIssue[],
): Promise<'alive' | 'dead' | 'unknown'> {
  try {
    return await context.platform.isScopeAlive(record.scope) ? 'alive' : 'dead';
  } catch (error) {
    issues.push({
      processId: record.id,
      code: 'scope_identity_unavailable',
      message: `Could not establish liveness of ${record.scope.kind}:${record.scope.id}: ${messageOf(error)}`,
    });
    return 'unknown';
  }
}

function uncontrolledSnapshot(record: DurableProcessRecord, error: string): ManagedProcessSnapshot {
  return {
    ...snapshotFromRecord(record, 'unresolved', null, error),
    pid: null,
    scope: null,
    startedAt: null,
  };
}

async function removeRecord(context: ReconciliationContext, record: DurableProcessRecord): Promise<void> {
  await context.recordStore.remove(record.id);
  await context.onRecordRemoved(record);
}
