import { describe, expect, it } from 'vitest';

import { classifyPiSession } from './piSessionClassifier';

const config = {
  defaults: { target: { name: 'General' }, cwd: '/home/monika', homeCwds: ['/home/monika'] },
  system: {
    parent: 'System',
    cwd: '/home/monika',
    sleep: { name: 'Sleep' },
    delegate: { name: 'Delegates' },
    fork: { name: 'Forks' },
  },
  rules: [
    {
      target: { name: 'Monika Runtime' },
      cwd: '/home/monika/repos/monika',
      cwdPrefixes: ['/home/monika/repos/monika'],
      homeKeywords: ['agentd'],
    },
    {
      target: { name: 'Monika Forum' },
      cwd: '/home/monika/repos/monika-forum',
      cwdPrefixes: ['/home/monika/repos/monika-forum'],
      homeKeywords: [],
    },
  ],
};

describe('classifyPiSession', () => {
  it('uses the longest cwd prefix', () => {
    const result = classifyPiSession({ path: '/sessions/1.jsonl', cwd: '/home/monika/repos/monika-forum' }, [], config);
    expect(result.target).toEqual({ name: 'Monika Forum' });
    expect(result.forumCwd).toBe('/home/monika/repos/monika-forum');
  });

  it('routes system sessions before cwd rules', () => {
    const result = classifyPiSession(
      { path: '/sessions/2.jsonl', cwd: '/home/monika/repos/monika' },
      [{ type: 'message', role: 'user', text: '=== FOCUSED TASK MODE ===\nDo a thing' }],
      config
    );
    expect(result.target).toEqual({ parent: 'System', name: 'Delegates' });
    expect(result.forumCwd).toBe('/home/monika');
  });

  it('uses home keywords only for configured home cwds', () => {
    const result = classifyPiSession(
      { path: '/sessions/3.jsonl', cwd: '/home/monika' },
      [{ type: 'message', role: 'user', text: 'Can you inspect agentd?' }],
      config
    );
    expect(result.target).toEqual({ name: 'Monika Runtime' });
  });

  it('falls back to the configured default cwd', () => {
    const result = classifyPiSession({ path: '/sessions/4.jsonl', cwd: '/tmp/elsewhere' }, [], config);
    expect(result.target).toEqual({ name: 'General' });
    expect(result.forumCwd).toBe('/home/monika');
  });
});
