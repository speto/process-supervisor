# Why `process-supervisor` exists

`process-supervisor` is an embeddable library for durable subprocess ownership.

The core lifecycle is:

```text
controller
    ↓ starts
managed process
    ↓
controller crashes / restarts / is rebuilt
    ↓
managed process may keep running
    ↓
new controller instance
    ↓
reconcile persisted state with OS
    ↓
verify identity
    ↓
adopt it and regain lifecycle control
```

## Typical use cases

### Long-running local services

A developer tool may manage several independent processes:

```text
developer tool
├── local MCP server
├── public tunnel
├── web admin
└── development server
```

Restarting or rebuilding the controller should not require restarting every healthy child process. A replacement controller can reconcile the surviving processes and regain ownership.

### Replaceable web admin

A local daemon may expose a separate web administration process:

```text
daemon
├── web admin
├── API
└── managed processes
```

The web admin can be rebuilt or restarted while the managed workloads continue running. After reconnecting, it can still expose process state, logs and lifecycle controls because ownership is persisted outside that web process.

### Public tunnels

A managed tunnel may expose another local service to an external client. If the administration layer or controller is restarted, there is no reason to tear down a healthy tunnel and invalidate an existing remote connection.

The surviving tunnel can be reconciled and adopted after restart.

### Development servers

Typical managed processes include Metro, Expo, Vite, Astro, local APIs and other project-specific development servers.

A developer tool can start them, expose their state through a local or remote admin UI, and stop or restart them when necessary. If the controller crashes while the development server remains healthy, the replacement controller can adopt it instead of restarting it.

### Processes that outlive the controller

Consider a process started by the application:

```text
npm run dev → PID 48122
```

The process remains alive, but the controller crashes or is upgraded. Without persistent ownership, the replacement controller has lost the fact that it started PID `48122`.

`process-supervisor` verifies the PID, process group, start identity and command fingerprint before treating the surviving process as owned. This prevents previously managed processes from becoming unknown orphans after a controller restart and protects against PID reuse.

### Durable logs

Persistent services can use file-backed logs:

```text
service starts
    ↓
writes logs
    ↓
supervisor restarts
    ↓
service keeps writing
    ↓
new supervisor adopts service
    ↓
log access continues
```

Log history therefore does not depend on the lifetime of the process that originally spawned the service. This is also useful for diagnosing a service that survived a controller failure or failed to terminate cleanly.

### Rebuilding the controller

During development, the supervising application itself may be rebuilt frequently.

Instead of:

```text
rebuild controller
    ↓
kill everything
    ↓
restart everything
```

the lifecycle can be:

```text
MCP server ───────────── running
development server ──── running
tunnel ──────────────── running

old controller
    ↓ replaced

new controller
    ↓ reconcile
    ├── adopt MCP server
    ├── adopt development server
    └── adopt tunnel
```

The control plane can be replaced without making every managed workload disposable.

### Selective restart

Only the failing layer needs to be restarted:

```text
web admin broken      → restart web admin
dev server wedged     → restart dev server
MCP server broken     → restart MCP server
tunnel broken         → restart tunnel
controller upgraded   → restart controller
```

Healthy processes remain untouched.

### Process trees

Development commands often create descendants:

```text
npm
└── node
    └── development server
        └── helper
```

`process-supervisor` tracks the owned process group so stopping a service stops the owned scope rather than only the original PID.

### Different ownership modes

Not every child process should survive the controller.

Tightly coupled processes can use piped stdio and terminate with the controller. Independent services can use durable logs and adoption.

```text
controller-owned child
→ terminates with controller

durable service
→ survives controller
→ adopted after restart
```

## Why existing tools did not fit

| Solution | Limitation for this use case |
| --- | --- |
| Node `child_process` | Spawn/signals only. No persistence, reconciliation or adoption. |
| Execa | Better execution/termination API, but no ownership across supervisor restarts. |
| `pidtree`, `tree-kill`, `kill-process-group` | Individual PID/tree primitives only. |
| `foreground-child` | Couples child lifetime to the current parent. |
| `forever-monitor` | Monitoring/restart model, not durable re-adoption. |
| nodemon | Development file watcher/reloader. |
| PM2 | Full process manager. PM2 owns the processes. |
| supervisord | Separate supervisor daemon plus configuration/control plane. |
| Process Compose | Process orchestration/scheduling layer. |
| Forever | Keep/restart scripts rather than application-owned adoption. |
| systemd / launchd | OS service manager owns the process. |

```text
child_process / Execa / PID helpers
        ↓
process-supervisor
        ↓
PM2 / supervisord / systemd / launchd
```

Lower-level libraries do not provide enough lifecycle semantics. Full process managers change the ownership model and introduce a separate management layer.

## Provided semantics

`process-supervisor` provides:

- direct subprocess spawning;
- persistent process records;
- process-group ownership;
- PID + process-start identity verification;
- command fingerprint verification;
- PID-reuse protection;
- restart reconciliation;
- surviving-process adoption;
- durable logs;
- safe process-tree termination;
- exclusive supervisor state ownership.

It deliberately does not provide:

- automatic restart policies;
- dependency graphs;
- clustering;
- deployment;
- health-check orchestration;
- a standalone daemon.

PM2 and supervisord own applications and keep them running. `process-supervisor` lets an application own subprocesses durably, including across restarts of the application itself.
