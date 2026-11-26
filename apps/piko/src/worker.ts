// The Temporal worker: runs Piko's task workflows and their activities. Stop it any time; tasks resume
// where they left off when a worker comes back.
//
// Before taking work it replays every running task against the code it is about to run. A task whose history
// no longer fits (its workflow code changed while it waited) would fail on every step and swallow the user's
// messages, so it is retired first, and anything it owed the user starts over as a new task (src/tasks.ts).
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, DefaultLogger, NativeConnection, Runtime, Worker, type WorkflowBundle } from '@temporalio/worker';
import * as activities from './activities.js';
import { config } from './config.js';
import { retire, startTask } from './tasks.js';

async function retireBroken(client: Client, workflowBundle: WorkflowBundle): Promise<void> {
  const running = client.workflow.list({ query: `TaskQueue = '${config.taskQueue}' AND ExecutionStatus = 'Running'` });
  const broken: string[] = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle, replayName: 'piko-startup-check' }, running.intoHistories())) {
    if (result.error) broken.push(result.workflowId);
  }
  for (const workflowId of broken) {
    const { redo, userId } = await retire(client, workflowId, 'Piko was updated and this task no longer fits the new code.');
    if (userId && redo.length > 0) {
      const taskId = await startTask(client, { userId, text: redo.join('\n'), taskId: `${workflowId}-r` });
      console.log(`↻ retired ${workflowId} (code changed while it ran); its unanswered request continues as ${taskId}`);
    } else {
      console.log(`↻ retired ${workflowId} (code changed while it ran); nothing was left unanswered`);
    }
  }
}

Runtime.install({ logger: new DefaultLogger('WARN') }); // keep the bundler's build report out of the log
const workflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  logger: new DefaultLogger('WARN'),
});
const client = new Client({ connection: await Connection.connect({ address: config.temporalAddress }) });
await retireBroken(client, workflowBundle);

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: config.temporalAddress }),
  namespace: 'default',
  taskQueue: config.taskQueue,
  workflowBundle,
  activities,
});
console.log(`Piko worker ready (model: ${config.fakeModel ? 'fake' : config.model})`);
await worker.run();
