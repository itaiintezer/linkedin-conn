// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { confirmSentMessage, messageNeedle, squeeze } from '../../src/core/message-confirm.js';

// The cohort-10 template shape that failed 100% of the time on 2026-08-25..31: a greeting,
// a blank line, then the body. `sent40` always spans the greeting boundary.
const TEMPLATE = 'Hi Philip,\n\nI am directly messaging and sharing with my network in Charlotte this unlimited complimentary pass. \n\nRegister Here';

/** textContent of a LinkedIn thread body rendered from `html`, as the browser would read it —
 *  the point being that `<br>` contributes nothing and `<!---->` nothing. */
function bodyText(html: string): string {
  const div = document.createElement('div');
  div.className = 'msg-s-event-listitem__body';
  div.innerHTML = html;
  return div.textContent ?? '';
}

// Verbatim from data/incidents/2026-08-28T19-57-15-send-failed.html on Dominic's machine:
// the delivered message, newlines rendered as bare <br><br>.
const BR_BODY = bodyText(
  '<!---->Hi Philip,<!----><br><br><!---->I am directly messaging and sharing with my network in Charlotte this unlimited complimentary pass.<span class="white-space-pre"> </span><!----><br><br><!---->Register Here<!---->',
);
// The rendering LinkedIn used on 2026-08-26 (and Itai's machine): a whitespace-bearing
// separator survives at the break, which is why the old check happened to pass there.
const SPACE_BODY = bodyText(
  '<!---->Hi Philip,<!----><span class="white-space-pre"> </span><br><!---->I am directly messaging and sharing with my network in Charlotte this unlimited complimentary pass. <br><!---->Register Here<!---->',
);

const READ_OK = { boxText: '', events: ['Philip Michello 10:19 AM', BR_BODY], failedBanner: false };

test('a <br>-rendered thread body confirms — the 2026-08-25..31 false negative', () => {
  // Sanity: this is the exact asymmetry. Collapsing whitespace leaves a space on our side
  // and none on the page's; the old needle could never match.
  expect(BR_BODY.replace(/\s+/g, ' ').trim().slice(0, 40)).toBe('Hi Philip,I am directly messaging and sh');
  expect(TEMPLATE.replace(/\s+/g, ' ').trim().slice(0, 40)).toBe('Hi Philip, I am directly messaging and s');

  const c = confirmSentMessage(READ_OK, TEMPLATE, []);
  expect(c.verdict).toBe('sent');
  expect(c).toMatchObject({ cleared: true, inThread: true, failed: false, matchesBefore: 0, matchesAfter: 1 });
});

test('the whitespace-bearing rendering still confirms — do not break what works', () => {
  const c = confirmSentMessage({ ...READ_OK, events: [SPACE_BODY] }, TEMPLATE, []);
  expect(c.verdict).toBe('sent');
});

test('a Windows-authored template (\\r\\n) confirms against either rendering', () => {
  const crlf = TEMPLATE.replace(/\n/g, '\r\n');
  expect(confirmSentMessage(READ_OK, crlf, []).verdict).toBe('sent');
  expect(confirmSentMessage({ ...READ_OK, events: [SPACE_BODY] }, crlf, []).verdict).toBe('sent');
});

test('bidi and zero-width marks a right-to-left UI injects are ignored on both sides', () => {
  // U+200F (RLM) has already reached a greeting once (see readFirstName); a Hebrew-chrome
  // LinkedIn wrapping the body in isolates must not un-confirm a delivered message.
  const rtl = `\u2067${BR_BODY.replace(',', ',\u200F')}\u2069`; // FSI … RLM … PDI
  expect(squeeze(rtl)).toBe(squeeze(BR_BODY));
  expect(confirmSentMessage({ ...READ_OK, events: [rtl] }, TEMPLATE, []).verdict).toBe('sent');
  // …and NBSP typed into a template is whitespace too.
  expect(confirmSentMessage(READ_OK, TEMPLATE.replace('Hi ', 'Hi\u00A0'), []).verdict).toBe('sent');
});

test('an empty thread does not confirm — the send was accepted, so it is unconfirmed, not error', () => {
  const c = confirmSentMessage({ boxText: '', events: [], failedBanner: false }, TEMPLATE, []);
  expect(c.verdict).toBe('unconfirmed');
  expect(c).toMatchObject({ cleared: true, inThread: false });
});

test('a page whose thread never rendered (the genuine failures in the same directory) does not confirm', () => {
  // ERR_NAME_NOT_RESOLVED-style captures: no msg-s-event elements at all, composer never
  // existed. Nothing here may flip to `sent`.
  const c = confirmSentMessage({ boxText: '', events: ['Something went wrong', 'Retry'], failedBanner: false }, TEMPLATE, []);
  expect(c.verdict).not.toBe('sent');
});

test('NOVELTY: a thread carrying only a PREVIOUS copy of the text does not confirm', () => {
  // The retried-row state: Philip's thread already held our message from 08-28 when the
  // 08-31 retry ran. Matching that copy would have "confirmed" the duplicate as fresh.
  const before = ['Philip Michello 10:19 AM', BR_BODY];
  const c = confirmSentMessage({ boxText: '', events: before, failedBanner: false }, TEMPLATE, before);
  expect(c.verdict).toBe('unconfirmed');
  expect(c).toMatchObject({ matchesBefore: 1, matchesAfter: 1, inThread: false });
});

test('NOVELTY: a second identical copy (count grew) confirms — text identity cannot tell them apart, a count can', () => {
  const before = [BR_BODY];
  const c = confirmSentMessage({ boxText: '', events: [BR_BODY, 'You 10:20 AM', BR_BODY], failedBanner: false }, TEMPLATE, before);
  expect(c.verdict).toBe('sent');
  expect(c).toMatchObject({ matchesBefore: 1, matchesAfter: 2 });
});

test('nested msg-s-event elements all carrying the body are fine — growth is growth', () => {
  // `[class*="msg-s-event"]` matches the listitem, its body, and wrappers: one message can
  // add several matching elements. The verdict only asks that MORE carry the needle.
  const before = ['older message', 'older message body'];
  const after = [...before, `Philip Michello 10:19 AM ${BR_BODY}`, BR_BODY, BR_BODY];
  expect(confirmSentMessage({ boxText: '', events: after, failedBanner: false }, TEMPLATE, before).verdict).toBe('sent');
});

test('a composer still holding the text is an error — the click did not take', () => {
  const c = confirmSentMessage({ boxText: 'Hi Philip,\nI am directly messaging and sharing with my network', events: [], failedBanner: false }, TEMPLATE, []);
  expect(c.verdict).toBe('error');
  expect(c.cleared).toBe(false);
});

test('a composer that still holds our text while an old copy sits in the thread is still an error', () => {
  const before = [BR_BODY];
  const c = confirmSentMessage({ boxText: TEMPLATE, events: before, failedBanner: false }, TEMPLATE, before);
  expect(c.verdict).toBe('error');
});

test('LinkedIn\'s own failed-to-send banner is an error even when the text is visible', () => {
  const c = confirmSentMessage({ ...READ_OK, failedBanner: true }, TEMPLATE, []);
  expect(c.verdict).toBe('error');
  expect(c.failed).toBe(true);
});

test('an empty needle confirms nothing', () => {
  const c = confirmSentMessage({ boxText: '', events: ['anything', ''], failedBanner: false }, '   \n ', []);
  expect(c.verdict).toBe('unconfirmed');
  expect(c.inThread).toBe(false);
});

test('a short message (under the needle length) confirms on its whole text', () => {
  const c = confirmSentMessage({ boxText: '', events: [bodyText('Hi Dana!<br>')], failedBanner: false }, 'Hi Dana!\n', []);
  expect(c.verdict).toBe('sent');
});

test('messageNeedle truncates by code point so an emoji opener is not split', () => {
  const emoji = '👀'.repeat(45);
  expect(messageNeedle(emoji)).toBe('👀'.repeat(40));
  expect(messageNeedle('Hi  Dana,\n\nhello', 6)).toBe('HiDana');
  expect(messageNeedle('', 40)).toBe('');
});
