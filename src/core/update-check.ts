/**
 * "Is there anything to install?" — so the dashboard can stay silent when there is not.
 *
 * A badge that is always visible is a badge nobody reads, and worse, a standing invitation to
 * press a button that restarts The Machine for no reason. This asks git, and says nothing unless
 * the answer is yes.
 *
 * Failures are reported as `available: 0` with a reason rather than thrown. Being offline, or on
 * a laptop whose git credentials have expired, is not an error state for the dashboard — it just
 * means we do not know, and the right behaviour is to say nothing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const RELEASE_BRANCH = 'main';

export interface UpdateAvailability {
  available: number;
  changes: string[];
  checked_at: string;
  /** Present only when the check could not complete. Not shown to the operator. */
  error?: string;
}

/** Formats `git log --oneline` output as a change list, dropping the shas. */
export function parseChangeList(logOutput: string, cap = 20): string[] {
  return String(logOutput ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, cap)
    // The sha means nothing to a sales rep; the subject is the whole value of the list.
    .map((l) => l.replace(/^[0-9a-f]{7,40}\s+/i, ''));
}

export async function checkForUpdates(
  root: string,
  { now = new Date(), git = defaultGit }: { now?: Date; git?: (root: string, args: string[]) => Promise<string> } = {},
): Promise<UpdateAvailability> {
  const checked_at = now.toISOString();
  try {
    // --quiet so a slow network does not fill the log with progress lines.
    await git(root, ['fetch', '--quiet', 'origin', RELEASE_BRANCH]);
    // --no-merges, for the same reason `scripts/update.mjs` uses it on the after-the-fact
    // changelog: one PR merged with GitHub's button lands as the branch's own commit PLUS a
    // merge commit, so counting both told the operator "2 updates available" for one fix, and
    // listed "Merge pull request #40 from itaiintezer/claude/…" above it — the line that means
    // least to someone who has never seen a branch name.
    const range = `HEAD..origin/${RELEASE_BRANCH}`;
    let changes = parseChangeList(await git(root, ['log', '--oneline', '--no-merges', range]));
    if (changes.length === 0) {
      // Almost always "up to date". But `main` can be ahead by a merge commit whose own commits
      // are already here, and hiding a real update is worse than naming it badly: an operator
      // cannot run git to discover one for themselves.
      changes = parseChangeList(await git(root, ['log', '--oneline', range]));
    }
    return { available: changes.length, changes, checked_at };
  } catch (e) {
    return {
      available: 0,
      changes: [],
      checked_at,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function defaultGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, timeout: 60_000, encoding: 'utf8' });
  return stdout.trim();
}
