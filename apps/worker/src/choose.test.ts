import { describe, expect, it } from 'vitest';
import { createTask, type ConnectionCredential } from '@relay/shared';
import { ClaudeDriver } from './claude.js';
import { NOT_CONNECTED, NotConnectedDriver, driverFor } from './choose.js';
import { SimulatedDriver } from './simulated.js';

const claude = [{ id: 'claude', kind: 'anthropic', apiKey: 'sk-ant-test' }] as unknown as ConnectionCredential[];

describe('driverFor', () => {
  it('runs the real agent with the key you connected', () => {
    expect(driverFor(claude, {})).toBeInstanceOf(ClaudeDriver);
  });

  it('keeps the simulation for tests and demos when asked for explicitly', () => {
    expect(driverFor(claude, { RELAY_DRIVER: 'simulated' })).toBeInstanceOf(SimulatedDriver);
  });

  it('says plainly that nothing is connected instead of pretending', async () => {
    const driver = driverFor([], {});
    expect(driver).toBeInstanceOf(NotConnectedDriver);
    const task = createTask({ kind: 'agent', title: 'x', utterance: 'email Alex' });
    expect(await driver.run(task, undefined as never)).toEqual({
      type: 'done',
      result: { summary: NOT_CONNECTED, setup: { connection: 'claude', label: 'Set up Claude' } },
    });
  });
});
