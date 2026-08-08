import { test, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver } from '../../src/browser/driver.js';
import { LinkedInDriver } from '../../src/browser/linkedin-driver.js';
import { FakeProfilePage } from '../helpers/fake-profile-page.js';

/** LinkedInDriver against a fake page: session whose page() returns the fake. */
function driverFor(page: FakeProfilePage, incidentsDir: string): LinkedInDriver {
  return new LinkedInDriver({ page: async () => page, launched: true } as never, incidentsDir);
}

// The 'already' skip verdict parks a profile terminally, so it must carry the same
// evidence the other judged verdicts do — the 2026-08-07 false-skip investigation found
// 21 of 105 verdicts were this skip, and not one had a screenshot to check it against.
test('a pending pre-visit skip captures evidence and reports the signals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/jane-doe-123/',
    title: 'Jane Doe | LinkedIn',
    elements: [{
      tag: 'a',
      attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Jane Doe' },
      cardSlug: 'jane-doe-123',
    }],
  });
  const outcome = await driverFor(page, dir)
    .sendConnectionRequest('https://www.linkedin.com/in/jane-doe-123', null, { firstName: 'Jane' });
  expect(outcome.result).toBe('already');
  expect(outcome.relationship).toBe('pending');
  expect(outcome.signals?.pendingForTarget).toBe(true);
  expect(outcome.evidence?.screenshot).toBeTruthy();
  expect(existsSync(join(dir, outcome.evidence!.screenshot!))).toBe(true);
}, 20_000);

test('a connected pre-visit skip (via the expanded overflow) captures evidence too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/john-roe/',
    title: 'John Roe | LinkedIn',
    hasMoreButton: true,
    overflowOnExpand: [{ attrs: { role: 'menuitem' }, text: 'Remove connection' }],
  });
  const outcome = await driverFor(page, dir)
    .sendConnectionRequest('https://www.linkedin.com/in/john-roe', null, { firstName: 'John' });
  expect(outcome.result).toBe('already');
  expect(outcome.relationship).toBe('connected');
  expect(outcome.signals?.removeConnection).toBe(true);
  expect(outcome.evidence?.screenshot).toBeTruthy();
}, 20_000);

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

test('FakeDriver reports the name it actually used, as the real driver does', async () => {
  // The sender stamps profiles.first_name from outcome.firstName. LinkedInDriver returns the
  // injected name when there is one, so the fake must too — otherwise every sender test runs
  // against a double that records a different name than production would.
  const d = new FakeDriver();
  d.firstName = 'Scraped';
  const invite = await d.sendConnectionRequest('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Ada' });
  expect(invite.firstName).toBe('Ada');
  const msg = await d.sendMessage('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Grace' });
  expect(msg.firstName).toBe('Grace');
  // …and its own name when nothing is injected.
  expect((await d.sendConnectionRequest('https://www.linkedin.com/in/b', null)).firstName).toBe('Scraped');
});
