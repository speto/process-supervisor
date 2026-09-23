import {ProcessSupervisor} from '../../src/index.js';

const stateDirectory = process.argv[2];
const cwd = process.argv[3];
if (!stateDirectory || !cwd) throw new Error('state directory and cwd are required');

const supervisor = new ProcessSupervisor({stateDirectory, groupPollMs: 10});
void supervisor.run({
  id: 'finite-recovery',
  executable: process.execPath,
  args: ['-e', 'setInterval(()=>{},1000);'],
  cwd,
}).catch(() => undefined);

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  const snapshot = supervisor.getSnapshot('finite-recovery');
  if (snapshot?.state === 'running' && snapshot.pid) {
    process.stdout.write(`${JSON.stringify({pid: snapshot.pid})}\n`);
    setInterval(() => {}, 1_000);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
