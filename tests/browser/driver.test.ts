import { test, expect } from 'vitest';
import { FakeDriver } from '../../src/browser/driver.js';

test('FakeDriver returns the scripted connection cards', async () => {
  const d = new FakeDriver();
  d.connectionCards = [
    { url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace' },
    { url: 'https://www.linkedin.com/in/grace', name: null },
  ];
  await expect(d.readConnectionCards()).resolves.toEqual(d.connectionCards);
});

test('FakeDriver can script a card-read failure', async () => {
  const d = new FakeDriver();
  d.connectionCardsError = 'checkpoint detected during roster sync';
  await expect(d.readConnectionCards()).rejects.toThrow('checkpoint detected during roster sync');
});
