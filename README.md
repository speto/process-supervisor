# process-supervisor

Own subprocess scopes explicitly, stop them reliably, and reconcile persistent ownership after the supervising process restarts.

Use it for long-running developer tools, local services, and finite commands that need stronger lifecycle guarantees than a raw `child_process.spawn()` call.

It provides:

- direct executable launch with no shell by default;
- exclusive ownership of the default file-backed state directory;
- isolated POSIX process groups and whole-group graceful → forced shutdown;
- line-oriented output, raw stdio transport, durable file-backed logs, or bounded finite-command output;
- finite command execution with timeout and the same whole-scope stop semantics;
- stable PID-reuse protection based on process-start identity;
- restart reconciliation for terminating or adopting surviving processes.

It is not a general-purpose service orchestrator. There are no dependency graphs, restart policies, containers, or PTY multiplexing.

## Why this exists

`child_process` and execution libraries such as Execa manage subprocess execution well, but they do not persist process ownership and re-adopt surviving processes after the controlling application restarts.

PM2, supervisord, systemd and launchd solve a different problem: they become the process manager. `process-supervisor` keeps durable ownership inside the embedding application without introducing a separate supervisor daemon.

Typical use cases include:

- development servers, local services, MCP servers or tunnels that should survive a controller restart;
- rebuilding or restarting a daemon or web admin without restarting healthy managed processes;
- reconciling and adopting processes that survived a crash or rebuild;
- retaining file-backed logs across controller restarts;
- safely stopping an owned process scope instead of only its original PID;
- avoiding signals to an unrelated process after PID reuse.

See [Why `process-supervisor` exists](docs/why-process-supervisor.md) for the detailed rationale and comparison with existing tools.

## Install

The package is published privately to GitHub Packages. Configure the `@speto` scope in the consuming repository:

```ini
@speto:registry=https://npm.pkg.github.com
```

Authenticate npm with a GitHub token that has `read:packages`, then install the package:

```sh
npm install @speto/process-supervisor
```

GitHub Actions can use its `GITHUB_TOKEN` when the consuming repository has read access to the package. The GitHub Release also contains the exact verified `npm pack` artifact, but GitHub Packages is the canonical dependency source.

Node.js 22+. The built-in platform adapter supports macOS and Linux. Other platforms can provide their own `ProcessPlatform` implementation.

## Use

```ts
import {ProcessSupervisor} from '@speto/process-supervisor';

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

An optional `argv0` can give a managed process a recognizable POSIX process title without changing the executable that is launched. Node documents this as the process title on macOS and Linux; treat it as an operational label, not an ownership or identity proof, and do not assume every process-manager UI renders it identically.

The default I/O mode is `line`: stdout/stderr are emitted as bounded line events through `onOutput`.

## Finite commands

Use `run()` when a process is expected to exit on its own:

```ts
const result = await supervisor.run({
  id: 'validation',
  executable: '/absolute/path/to/npm',
  args: ['test'],
  cwd: '/absolute/path/to/project',
}, {
  timeoutMs: 300_000,
  maxOutputBytes: 8 * 1024 * 1024,
});
```

A finite command uses the same owned process scope, durable ownership, stable identity checks, reconciliation, and graceful → forced termination as a long-running process. Natural exit resolves normally even when the exit code is non-zero; the caller decides what that exit code means.

While `run()` is pending, `stop(id)` stops the same owned process scope and the run resolves with `reason: 'stopped'`. A timeout or combined stdout/stderr output limit terminates the scope through the same stop path and reports `timed_out` or `output_limit`.

Finite commands use terminate-on-recovery semantics and are not adopted or preserved across supervisor replacement.

## Raw stdio

Use `pipe` for byte-preserving bidirectional protocols:

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

`pipe` streams belong to the current supervisor and therefore cannot use `adopt` recovery or `preserve` shutdown.

## Durable services

A non-interactive service can survive its supervisor and be adopted by a new one:

```ts
await supervisor.start({
  id: 'dev-server',
  executable: '/absolute/path/to/npm',
  args: ['run', 'dev'],
  cwd: '/absolute/path/to/project',
  ioMode: 'durable-log',
  recoveryPolicy: 'adopt',
  shutdownPolicy: 'preserve',
});
```

After restart:

```ts
const recovered = new ProcessSupervisor({
  stateDirectory: '/absolute/path/to/runtime-state',
});

const result = await recovered.reconcile();
console.log(result.adopted);
```

An adopted process regains status, log access, and stop/restart control while its recorded identity remains verifiable.

```ts
const output = await recovered.readOutputTail('dev-server', 'stdout');
```

`restart()` receives the full process specification again. Environment values are not persisted.

## Recovery

| I/O | Recovery | Intended use |
| --- | --- | --- |
| `line` | `terminate` | workers with line-oriented application logs |
| `pipe` | `terminate` | stdio protocols owned by the current supervisor |
| `durable-log` | `terminate` | surviving processes that should be cleaned up after restart |
| `durable-log` | `adopt` | reconnectable non-interactive services |

The default file-backed registry uses an ownership lease so two supervisors cannot control the same state directory concurrently.

A PID alone is never treated as ownership proof. Persistent records bind the PID to a stable process-start identity. A reused or mismatched PID is not signalled.

If a recovered process scope is still alive but its recorded leader identity cannot be proven, it remains `unresolved` rather than being signalled speculatively.

## State and logs

The default state directory and durable-log directories are private to the current user on supported POSIX systems. Unsafe directories fail closed.

Durable logs retain the most recent three launches per process ID by default. Each actively supervised stdout/stderr log is bounded to 16 MiB by default. Both limits are configurable.

Do not place secrets in command-line arguments, metadata, or durable output. Arguments are visible through the operating-system process table; metadata and durable output are persisted on disk.

## Process scopes

`ProcessPlatform` exposes an opaque process scope. The built-in adapter maps that scope to an isolated POSIX process group.

A descendant that deliberately creates a new session or process group can escape that scope. The library does not claim arbitrary process-tree containment.

## Limits

- built-in adapter: macOS and Linux;
- no interactive PTY recovery;
- no automatic restart policy;
- no dependency graph or service orchestration;
- no ownership inference from process names or working-directory scans;
- durable-log byte limiting requires an active supervisor;
- process creation is not fully crash-atomic if the operating system or machine dies between spawn and durable record commit.

Source development on macOS requires Xcode Command Line Tools because the default adapter builds a small standalone `libproc` helper. Release tarballs already contain the universal arm64/x86_64 helper.

## Development

```sh
npm ci
npm run check
npm run package:verify
```

## Release

1. Update the version in `package.json` and regenerate `package-lock.json` if needed.
2. Run `npm ci`, `npm run check`, and `npm run package:verify`.
3. Commit the release-ready source.
4. Create and push the matching `vX.Y.Z` tag.
5. GitHub Actions validates the tag, builds and verifies the package, publishes the exact verified artifact as `@speto/process-supervisor` to GitHub Packages, then publishes the GitHub Release with the same tarball attached.
