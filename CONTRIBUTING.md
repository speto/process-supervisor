# Contributing

Contributions are welcome.

For substantial changes to behavior or the public API, open an issue first so the approach can be agreed before implementation.

## Development

Requires Node.js 22+. The built-in lifecycle integration tests run on macOS and Linux.

```sh
npm ci
npm run check
```

`npm run check` runs the type checks, tests, and production build.

For changes affecting the published package surface, also run:

```sh
npm pack --dry-run --ignore-scripts
```

## Architecture

Keep the dependency direction explicit:

- `ProcessSupervisor` owns lifecycle orchestration and state publication;
- `OwnershipCoordinator` serializes ownership-changing operations;
- `ProcessPlatform` owns operating-system process scopes, stable identity, launch, inspection, and termination;
- `ProcessRecordStore` owns durable record persistence;
- concrete filesystem and POSIX code stays behind those boundaries.

The library must not acquire product concepts such as MCP servers, agent runs, worktrees, projects, or tickets. Those belong to consuming applications.

Prefer names from the process-supervision domain (`ProcessIdentity`, `ProcessRecordStore`, `reconcile`) over generic names such as `Manager`, `Helper`, or `Utils`. Add an abstraction only when it isolates a real policy or infrastructure boundary.

## Pull requests

- Keep changes focused and reviewable.
- Add or update tests for lifecycle, concurrency, and recovery behavior changes.
- Preserve the fail-safe rule: never terminate a recovered process whose stable identity cannot be proven.
- Never discard durable ownership merely because cleanup failed; retain it for retry unless identity itself becomes unsafe.
- Update the README for user-visible changes.
- Preserve existing public API behavior unless a breaking change is intentional.
- Validate locally before pushing; hosted CI is merge validation, not an interactive development loop.

## AI-assisted contributions

AI tools are welcome. Unreviewed AI-generated output is not.

Before requesting review:

- understand the code you are submitting and be able to explain it;
- remove unnecessary abstractions, generated boilerplate, speculative features, and unrelated refactoring;
- follow the existing architecture and naming rather than introducing new patterns without a concrete need;
- clean up temporary, fixup, and exploratory commits where practical.

Pull requests should present a coherent change, not the full history of an exploratory implementation. Large generated patches, excessive commit churn, or code that has not been understood and verified by its author may be closed rather than reviewed.

AI tools should reduce implementation effort, not transfer the cost of understanding, cleanup, and verification to maintainers.

Contributions are submitted under the project's MIT License.
