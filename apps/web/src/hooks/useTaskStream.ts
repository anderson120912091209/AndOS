import { useEffect, useRef, useState } from 'react';
import type { Task } from '@relay/shared';

type WsMessage =
  | { type: 'snapshot'; tasks: Task[] }
  | { type: 'created'; task: Task }
  | { type: 'updated'; task: Task };

export interface TaskStream {
  tasks: Task[];
  connected: boolean;
}

/**
 * Live view of the queue. Subscribes to /ws, folds snapshot/created/updated events
 * into a Map keyed by id, and re-sorts newest-first. Auto-reconnects with backoff
 * so the UI survives a server restart during the demo.
 */
export function useTaskStream(): TaskStream {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const map = useRef(new Map<string, Task>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;

    const sync = () => {
      setTasks([...map.current.values()].sort((a, b) => b.createdAt - a.createdAt));
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type === 'snapshot') {
          map.current = new Map(msg.tasks.map((t) => [t.id, t]));
        } else {
          map.current.set(msg.task.id, msg.task);
        }
        sync();
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 400 * retry);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { tasks, connected };
}
