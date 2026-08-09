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

// Root cause 3.1 of the 2026-08-07 false skips: with 50+ invites outstanding, the
// operator's own Pending badges render on the recommendation cards of every profile they
// visit, and the old page-wide fallback read one as the target's. A neighbour badge must
// not stop the attempt: this connectable profile proceeds to the composer (and lands on
// 'unavailable' only because the fake page has none).
test("a neighbour card's pending badge does not skip a connectable target", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/target-person-123/',
    title: 'Target Person | LinkedIn',
    elements: [
      {
        tag: 'button',
        attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Neighbour Guy' },
        cardSlug: 'neighbour-guy-9z',
      },
      {
        tag: 'a',
        attrs: {
          'aria-label': 'Invite Target Person to connect',
          href: '/preload/custom-invite/?vanityName=target-person-123',
        },
        cardSlug: 'target-person-123',
      },
    ],
  });
  const outcome = await driverFor(page, dir)
    .sendConnectionRequest('https://www.linkedin.com/in/target-person-123', null, { firstName: 'Target' });
  expect(outcome.result).not.toBe('already');
  expect(outcome.result).toBe('unavailable');
}, 40_000);

// Root cause 3.6, the same read in the opposite direction: after submitting, the old
// code confirmed 'sent' off ANY visible Pending badge — a neighbour's counted. A submit
// that never registers must not be recorded as sent.
test("a neighbour badge does not confirm a submitted invite as sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/target-person-123/',
    title: 'Target Person | LinkedIn',
    elements: [
      {
        tag: 'button',
        attrs: { 'aria-label': 'Pending, click to withdraw invitation sent to Neighbour Guy' },
        cardSlug: 'neighbour-guy-9z',
      },
      {
        tag: 'a',
        attrs: {
          'aria-label': 'Invite Target Person to connect',
          href: '/preload/custom-invite/?vanityName=target-person-123',
        },
        cardSlug: 'target-person-123',
      },
      // The composer IS present, so the submit itself succeeds — but no Pending badge
      // for the target ever appears afterwards.
      { tag: 'button', text: 'Send without a note', zone: 'body' },
    ],
  });
  const outcome = await driverFor(page, dir)
    .sendConnectionRequest('https://www.linkedin.com/in/target-person-123', null, { firstName: 'Target' });
  expect(outcome.result).not.toBe('sent');
  expect(outcome.result).toBe('unconfirmed');
}, 60_000);

// Root cause 3.2: a page showing NO relationship signal used to be skipped as already
// connected. It must now come back as relationship_unknown, with evidence, WITHOUT the
// composer ever being attempted — a page we could not read is not a page to submit against.
test('a signal-less page yields relationship_unknown and never opens the composer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const page = new FakeProfilePage({
    url: 'https://www.linkedin.com/in/ghost-person/',
    title: 'Ghost Person | LinkedIn',
    elements: [],
  });
  const outcome = await driverFor(page, dir)
    .sendConnectionRequest('https://www.linkedin.com/in/ghost-person', null, { firstName: 'Ghost' });
  expect(outcome.result).toBe('relationship_unknown');
  expect(outcome.relationship).toBe('unknown');
  expect(outcome.evidence?.screenshot).toBeTruthy();
  // No navigation to the custom-invite composer route: the invite was never attempted.
  expect(page.gotoLog.some((u) => u.includes('custom-invite'))).toBe(false);
}, 30_000);

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
