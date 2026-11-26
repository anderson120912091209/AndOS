import { useMemo } from 'react';
import { useTaskStream } from './hooks/useTaskStream.js';
import { TaskFeed } from './components/TaskFeed.js';
import { VoiceHud } from './components/VoiceHud.js';
import { isTerminal } from '@relay/shared';

export default function App() {
  const { tasks, connected } = useTaskStream();

  const counts = useMemo(() => {
    const active = tasks.filter((t) => t.kind === 'agent' && !isTerminal(t.status)).length;
    return { total: tasks.length, active };
  }, [tasks]);

  return (
    <div className="atmosphere relative flex h-full flex-col">
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 sm:px-8">
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-[19px] font-bold tracking-tight text-bone">Relay</span>
          <span className="hidden font-mono text-[11px] text-faint sm:inline">speak · it works · it comes back</span>
        </div>
        <div className="flex items-center gap-5">
          <span className="tabular font-mono text-[11px] uppercase tracking-wider text-faint">
            {counts.active > 0 ? (
              <span className="text-signal">{counts.active} working</span>
            ) : (
              <span>{counts.total} tasks</span>
            )}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-good' : 'bg-bad'}`}
              style={connected ? { boxShadow: '0 0 8px rgba(139,232,168,0.8)' } : undefined}
            />
            <span className={connected ? 'text-dim' : 'text-bad'}>{connected ? 'live' : 'offline'}</span>
          </span>
        </div>
      </header>

      {/* Feed */}
      <main className="relative z-10 flex-1 overflow-y-auto px-4 sm:px-8">
        <TaskFeed tasks={tasks} />
      </main>

      {/* Voice dock */}
      <VoiceHud />
    </div>
  );
}
