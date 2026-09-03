# process-supervisor

Own subprocess scopes explicitly, stop them reliably, and reconcile persistent ownership after the supervising process restarts.

The library is intended for long-running developer tools and local services that need stronger lifecycle guarantees than a raw `child_process.spawn()` call.

It provides:

- direct executable launch with no shell by default;
- exclusive ownership of the default file-backed state directory;
- isolated POSIX process groups and whole-group graceful → forced shutdown in the built-in adapter;
- raw bidirectional stdio transport or line-oriented output;
- stable PID-reuse protection based on process-start identity;
- durable file-backed logs for adoptable services;
- serialized lifecycle/reconciliation/close operations;
- restart reconciliation that either terminates or adopts a positively identified process.

It is not a general-purpose service orchestrator. There are no dependency graphs, restart policies, containers, or PTY multiplexing.

## Install

```sh
npm install github:speto/process-supervisor
```

Node.js 22+. The built-in platform adapter supports macOS and Linux. The package itself is not OS-gated so another `ProcessPlatform` implementation can be injected.

## Use

```ts
import {ProcessSupervisor} from 'process-supervisor';

const supervisor = new ProcessSupervisor({
  stateDirectory: '/absolute/path/to/runtime-state',
  onOutput: ({processId, stream, line}) => {
    console.log(processId, stream, line);
  },
});

await supervisor.start({
  id: 'worker',
  executable: '/absolute/path/to/node',
  args: ['/absolute/path/to/worker.js'],
  cwd: '/absolute/path/to/project',
});

await supervisor.stop('worker');
await supervisor.close();
```

Executables and working directories must be absolute. Commands are launched directly with `shell: false`.

The default I/O mode is `line`: stdout/stderr are converted to bounded line events through `onOutput`.

## Raw stdio protocols

Use `pipe` for a byte-preserving bidirectional protocol such as ACP:

```ts
await supervisor.start({
  id: 'agent',
  executable: '/absolute/path/to/agent',
  args: [],
  cwd: '/absolute/path/to/project',
  ioMode: 'pipe',
});

const transport = supervisor.getTransport('agent');
transport.stdin.write(requestBytes);
transport.stdout.on('data', handleResponseBytes);
```

`pipe` does not transform stdout/stderr into lines and does not emit them through `onOutput`. Its streams belong to the current supervisor, so it cannot use `adopt` recovery or `preserve` shutdown.

## Durable services

A non-interactive service can survive its supervisor and be adopted by a new one:

```ts
await supervisor.start({
  id: 'feature-a-dev-server',
  executable: '/absolute/path/to/npm',
  args: ['run', 'dev', '--', '--port', '4317'],
  cwd: '/absolute/path/to/feature-a',
  ioMode: 'durable-log',
  recoveryPolicy: 'adopt',
  shutdownPolicy: 'preserve',
  metadata: {
    kind: 'dev-server',
    workspace: 'feature-a',
  },
});
```

`durable-log` redirects stdout and stderr to launch-specific files. The child is detached from the supervisor's stdio and can continue running if the supervisor exits unexpectedly.

After restart:

```ts
const recovered = new ProcessSupervisor({
  stateDirectory: '/absolute/path/to/runtime-state',
});

const result = await recovered.reconcile();
console.log(result.adopted);
```

An adopted process regains status, log access, and stop/restart control. Existing logs are available through:

```ts
const output = await recovered.readOutputTail('feature-a-dev-server', 'stdout');
```

`restart()` receives the full process specification again. Environment values are deliberately not persisted.

## Recovery policies

| I/O | Recovery | Intended use |
| --- | --- | --- |
| `line` | `terminate` | workers whose stdout/stderr are application logs |
| `pipe` | `terminate` | stdio protocols whose parent owns the streams |
| `durable-log` | `terminate` | persistent ownership where a surviving process should be cleaned up after restart |
| `durable-log` | `adopt` | dev servers and other reconnectable non-interactive services |

`adopt` and `preserve` are rejected for parent-owned streams because anonymous pipes cannot be reconstructed after the parent disappears.

## Ownership and reconciliation

The default `FileProcessRecordStore` uses an exclusive lock in `stateDirectory`. Two live supervisors therefore cannot concurrently manage the same file-backed registry. A stale lock is reclaimed only when its recorded owner PID is no longer alive.

Lifecycle changes, reconciliation, adopted-process monitoring, and `close()` use one ownership coordinator. Reconciliation cannot concurrently adopt the same record twice, and `close()` cannot complete before an already accepted ownership operation settles.

If termination or residual cleanup fails, the process remains recorded and the snapshot becomes `unresolved`. Ownership is retained for a later cleanup attempt. `crashed` is reserved for a process whose exit and residual cleanup have been established.

Custom `ProcessRecordStore` implementations are responsible for their own cross-process exclusivity if multiple supervisors can share the same backing registry.

## Process identity

A PID is not ownership proof, and command text is mutable.

Persistent records bind the PID to an opaque platform process scope plus a stable process-start identity. On Linux the built-in adapter uses the kernel boot ID and `/proc/<pid>/stat` start ticks. On macOS it uses the kernel-reported process start time. The command fingerprint is retained only as supporting evidence and does not determine ownership.

A reused or mismatched PID is never signalled. Once identity is unsafe, the supervisor drops active control rather than guessing.

Raw command lines and environment values are not persisted. Process arguments are likewise not stored in the durable record; callers must provide a process specification again when starting or restarting a process.

Do not place secrets in command-line arguments. They are observable through the operating-system process table even though this library does not persist them.

## Process scopes

`ProcessPlatform` exposes an opaque `ProcessScope`, not POSIX process-group operations. The built-in adapter maps that scope to an isolated POSIX process group. A descendant that deliberately creates a new session/process group can escape that scope; the library does not claim arbitrary process-tree containment.

A future Windows adapter can map the same contract to Job Objects without exposing POSIX concepts in the public abstraction.

## Retention and monitoring

Durable logs keep the most recent three launches per process ID by default. Set `maxRetainedLogLaunches` to change that limit.

Terminal snapshots are bounded to 256 entries by default. Set `maxRetainedSnapshots` or call `forget(id)` for explicit eviction. Active ownership snapshots are not evicted.

Adopted-process liveness is probed in batches rather than one external `ps` invocation per process. Durable log followers back off while idle instead of polling every 100 ms indefinitely.

## Environment

The default child environment inherits only:

```text
HOME
TMPDIR
LANG
LC_ALL
```

`PATH` is inherited separately and the executable's directory is prepended. This supports tools whose shebang uses a sibling interpreter through `/usr/bin/env`.

Use `environment` on the process specification to change inherited names or provide explicit values. Environment values never enter durable process records.

## Limits

- the built-in platform adapter supports macOS and Linux; no Windows Job Object adapter is included yet;
- no interactive PTY recovery;
- no automatic restart policy;
- no attempt to infer ownership from process names or working-directory scans;
- POSIX process-group ownership does not include descendants that deliberately escape the group.

The durable record schema is currently version 2. Version 1 records from pre-release builds are rejected rather than guessed or migrated silently.

The guarantee is **persistent ownership with restart reconciliation**, not fully crash-atomic process creation: an OS-level crash can still occur between process creation and durable record persistence.

## Development

```sh
npm ci
npm run check
```

The test suite includes scope cleanup, forced termination, stable PID identity mismatch safety, state-directory exclusion, concurrent reconciliation, close/reconcile ordering, retained failed cleanup ownership, raw stdio transport, bounded retention, persistent-record isolation, and hard-crash adoption using separate OS processes.
