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

test('FakeDriver prefers an injected first name over the one it would read', async () => {
  const d = new FakeDriver();
  d.firstName = 'Scraped';
  await d.sendConnectionRequest('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Ada' });
  expect(d.sentLog[0].message).toBe('Hi Ada');
});

test('FakeDriver falls back to its own name when none is injected', async () => {
  const d = new FakeDriver();
  d.firstName = 'Scraped';
  await d.sendConnectionRequest('https://www.linkedin.com/in/a', 'Hi {firstName}');
  expect(d.sentLog[0].message).toBe('Hi Scraped');
});

test('an injected name flows into a direct message too', async () => {
  const d = new FakeDriver();
  await d.sendMessage('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Grace' });
  expect(d.msgLog[0].message).toBe('Hi Grace');
});
