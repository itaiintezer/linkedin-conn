import { lookup } from 'node:dns/promises';

/**
 * Classify browser errors that describe OUR connectivity rather than anything LinkedIn
 * did. The repeated_failures guardrail exists to catch "LinkedIn changed its UI or is
 * blocking us" — but a laptop that went to sleep produces the same shape of failure
 * (page.goto throwing), and between 2026-08-07 and 2026-08-16 every single
 * repeated_failures halt in the log was one of these: the machine suspended networking
 * (ERR_NETWORK_IO_SUSPENDED), lost the connection (ERR_INTERNET_DISCONNECTED), or lost
 * DNS (ERR_NAME_NOT_RESOLVED). Those recover on their own the moment the machine is back
 * online, so they must never latch a halt that needs a human to acknowledge.
 *
 * Blocking, by contrast, never looks like this: LinkedIn blocks with checkpoint pages,
 * missing controls or HTTP-level responses, all of which arrive over a WORKING network
 * and are detected elsewhere (CHECKPOINT_RE, the 'unavailable' verdicts).
 */

/**
 * Chromium net:: codes that can ONLY mean the machine itself is offline — suspended,
 * disconnected, or without name resolution. No LinkedIn-side behaviour produces these.
 */
const OFFLINE_RE = new RegExp(
  'net::ERR_('
  + 'NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|DNS_TIMED_OUT'
  + '|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED'
  + ')\\b',
);

/**
 * Errors a dead network CAN produce but a live-and-misbehaving LinkedIn could too:
 * TCP-level timeouts/resets and Playwright's own navigation timeout ("Timeout 30000ms
 * exceeded" — the shape both 2026-08-14 halts had, waking from sleep with a half-dead
 * network stack). These need the connectivity probe to disambiguate: offline → forgive,
 * online → count, because a timeout on a working network is real evidence.
 */
const AMBIGUOUS_RE = new RegExp(
  'net::ERR_('
  + 'TIMED_OUT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_REFUSED'
  + '|CONNECTION_CLOSED|CONNECTION_ABORTED|EMPTY_RESPONSE'
  + ')\\b'
  + '|Timeout \\d+ms exceeded',
);

/** True when the error message can only mean OUR network is down — never LinkedIn. */
export function isOfflineError(message: string): boolean {
  return OFFLINE_RE.test(message);
}

/** True when the error is network-shaped but could be either side — probe to decide. */
export function isAmbiguousNetworkError(message: string): boolean {
  return AMBIGUOUS_RE.test(message);
}

/**
 * Is the machine online enough to blame LinkedIn for a failure? One OS-level DNS lookup
 * of www.linkedin.com with a short deadline — cheap, browser-free, and exactly the layer
 * that dies first under sleep/wake. Any error or timeout reads as offline: erring toward
 * "offline" only delays a genuine halt by one more failure, while erring toward "online"
 * latches a red banner over a closed laptop lid.
 */
export async function probeOnline(timeoutMs = 3000): Promise<boolean> {
  try {
    await Promise.race([
      lookup('www.linkedin.com'),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('connectivity probe timed out')), timeoutMs);
        t.unref(); // never hold the process open for a probe
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
