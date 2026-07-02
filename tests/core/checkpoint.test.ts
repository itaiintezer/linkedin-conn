import { test, expect } from 'vitest';
import { detectCheckpoint } from '../../src/core/checkpoint.js';

const PROFILE = {
  url: 'https://www.linkedin.com/in/chitresh-sen/',
  title: 'Chitresh Sen | LinkedIn',
  headings: ['Chitresh Sen'],
};

test('checkpoint challenge URL is detected regardless of page text', () => {
  const scan = detectCheckpoint({
    url: 'https://www.linkedin.com/checkpoint/challenge/AgFy3z',
    title: '',
    headings: [],
  });
  expect(scan.hit).toBe(true);
  expect(scan.via).toBe('url');
  expect(scan.matched).toBeTruthy();
});

test('authwall and uas login URLs are detected', () => {
  expect(detectCheckpoint({ url: 'https://www.linkedin.com/authwall?trk=x', title: '', headings: [] }).hit).toBe(true);
  expect(detectCheckpoint({ url: 'https://www.linkedin.com/uas/login?session_redirect=x', title: '', headings: [] }).hit).toBe(true);
});

test('security-verification page title is detected', () => {
  const scan = detectCheckpoint({
    url: 'https://www.linkedin.com/in/someone/',
    title: 'Security Verification | LinkedIn',
    headings: [],
  });
  expect(scan.hit).toBe(true);
  expect(scan.via).toBe('page');
  expect(scan.matched).toMatch(/security verification/i);
});

test('challenge heading ("quick security check") is detected', () => {
  const scan = detectCheckpoint({
    url: 'https://www.linkedin.com/in/someone/',
    title: '',
    headings: ["Let's do a quick security check"],
  });
  expect(scan.hit).toBe(true);
  expect(scan.via).toBe('page');
});

test('restricted-account heading is detected', () => {
  const scan = detectCheckpoint({
    url: 'https://www.linkedin.com/feed/',
    title: '',
    headings: ["We've noticed some unusual activity"],
  });
  expect(scan.hit).toBe(true);
});

// Regression for the 2026-07-02 halt: a normal profile page must NOT trip just
// because its CONTENT mentions security words ("Checkpoint" the vendor, posts
// about captchas, "security check" in an article). Detection must ignore body
// HTML entirely and single security words in profile headings.
test('a security professional profile page does not false-positive', () => {
  const scan = detectCheckpoint(PROFILE);
  expect(scan.hit).toBe(false);
  expect(scan.matched).toBeNull();
});

test('profile heading mentioning Checkpoint-the-vendor does not trip', () => {
  const scan = detectCheckpoint({
    url: 'https://www.linkedin.com/in/nw-sec-eng/',
    title: 'Network Security Engineer - Checkpoint Firewall | LinkedIn',
    headings: ['Checkpoint & CAPTCHA expert', 'About', 'Activity'],
  });
  expect(scan.hit).toBe(false);
});

test('scan reports the inspected url and title', () => {
  const scan = detectCheckpoint(PROFILE);
  expect(scan.url).toBe(PROFILE.url);
  expect(scan.title).toBe(PROFILE.title);
});
