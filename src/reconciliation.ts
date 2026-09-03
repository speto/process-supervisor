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
  let checked = 0;
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

    const record = entry.record;
    if (context.isAlreadyManaged(record.id)) continue;
    checked += 1;

    let inspection;
    try {
      inspection = await context.platform.inspect(record.pid);
    } catch (error) {
      unresolved += 1;
      issues.push({processId: record.id, code: 'inspection_failed', message: messageOf(error)});
      continue;
    }

    if (inspection === null) {
      dead += 1;
      await removeRecord(context, record);
      context.publish(snapshotFromRecord(record, 'stopped', null, null));
      continue;
    }

    if (!identityMatches(record, inspection)) {
      stale += 1;
      await removeRecord(context, record);
      context.publish({
        ...snapshotFromRecord(record, 'unresolved', null, null),
        pid: null,
        scope: null,
        startedAt: null,
        error: 'Recorded PID now belongs to a different process identity. Ownership was discarded without signalling it.',
      });
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

async function removeRecord(context: ReconciliationContext, record: DurableProcessRecord): Promise<void> {
  await context.recordStore.remove(record.id);
  await context.onRecordRemoved(record);
}
