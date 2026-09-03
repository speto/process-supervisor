import {ProcessSupervisor} from '../../src/index.js';

const [stateDirectory, cwd] = process.argv.slice(2);
if (!stateDirectory || !cwd) throw new Error('stateDirectory and cwd are required.');

const supervisor = new ProcessSupervisor({stateDirectory});
const running = await supervisor.start({
  id: 'durable-server',
  executable: process.execPath,
  args: [
    '-e',
    `console.log('ready'); let tick=0; setInterval(()=>console.log('tick:'+String(++tick)),100);`,
  ],
  cwd,
  ioMode: 'durable-log',
  recoveryPolicy: 'adopt',
  shutdownPolicy: 'preserve',
});

process.stdout.write(`${JSON.stringify({pid: running.pid})}\n`);
setInterval(() => {}, 1_000);
