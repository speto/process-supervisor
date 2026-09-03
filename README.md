# process-supervisor

Own subprocess trees explicitly, stop them reliably, and recover their ownership after the supervising process restarts.

The library is intended for long-running developer tools and local services that need stronger lifecycle guarantees than a raw `child_process.spawn()` call.

It provides:

- direct executable launch with no shell by default;
- isolated POSIX process groups and whole-group `SIGTERM` → `SIGKILL` shutdown;
- bounded stdout/stderr line delivery;
- crash-safe process records with PID-reuse protection;
- durable file-backed logs for adoptable services;
- restart reconciliation that either terminates or adopts a positively identified process.

It is not a general-purpose service orchestrator. There are no dependency graphs, restart policies, containers, or PTY multiplexing.

## Install

```sh
npm install github:speto/process-supervisor
```

Node.js 22+. macOS and Linux are supported by the built-in POSIX adapter.

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
```

Executables and working directories must be absolute. Commands are launched directly with `shell: false`.

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

`durable-log` redirects stdout and stderr to launch-specific files. The child is detached from the supervisor's stdio and can continue running if the supervisor crashes.

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
| `pipe` | `terminate` | stdio protocols, short-lived workers, processes whose parent owns the streams |
| `durable-log` | `terminate` | persistent ownership where a surviving child should be cleaned up after restart |
| `durable-log` | `adopt` | dev servers and other reconnectable non-interactive services |

`adopt` is rejected for `pipe` processes because anonymous pipes cannot be reconstructed after the parent process disappears.

## Process identity

A PID is not ownership proof.

Persistent records bind the PID and process-group ID to the observed process start time and a SHA-256 fingerprint of its command line. Reconciliation signals a surviving process only when that identity still matches. A reused or mismatched PID is discarded without being killed.

Raw command lines and environment values are not persisted. Process arguments are likewise not stored in the durable record; callers must provide a process specification again when starting or restarting a process.

Do not place secrets in command-line arguments. They are observable through the operating-system process table even though this library does not persist them.

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

The current implementation is intentionally narrow:

- macOS and Linux only;
- no Windows Job Object adapter yet;
- no interactive PTY recovery;
- no automatic restart policy;
- no active log-file rotation;
- no attempt to infer ownership from process names or working-directory scans.

If a recovered process leader is already gone, the library does not guess that a residual process group is still safe to signal.

## Development

```sh
npm install
npm run check
```

The test suite includes whole-process-group cleanup, forced termination, PID identity mismatch safety, persistent-record isolation, and a hard-crash adoption test using separate OS processes.
