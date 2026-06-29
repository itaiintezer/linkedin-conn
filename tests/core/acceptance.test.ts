import { test, expect } from 'vitest';
import { computeAcceptanceTransitions } from '../../src/core/acceptance.js';

test('classifies resolved invites as accepted or expired', () => {
  const sent = [
    { id: 1, profile_url: 'https://www.linkedin.com/in/a' },
    { id: 2, profile_url: 'https://www.linkedin.com/in/b' },
    { id: 3, profile_url: 'https://www.linkedin.com/in/c' },
  ];
  const pending = new Set(['https://www.linkedin.com/in/a']);
  const connections = new Set(['https://www.linkedin.com/in/b']);
  const r = computeAcceptanceTransitions(sent, pending, connections);
  expect(r.accepted).toEqual([2]);
  expect(r.expired).toEqual([3]);
});
