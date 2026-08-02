import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    /**
     * PIN THE ZONE FOR THE WHOLE SUITE.
     *
     * The planner slices the LOCAL workday (`workday_start_hour`..`workday_end_hour` are
     * read through Date#getHours), so every absolute instant it produces moves with the
     * machine's offset. tests/worker/plan-queue-regression.test.ts snapshots those instants
     * as UTC strings: on the author's UTC+3 box all four snapshots were green, and on a
     * UTC CI runner all four failed by exactly three hours.
     *
     * That file is the one lock whose entire purpose is to be a lock, and the predictable
     * response to four red snapshots is `vitest -u` — which rewrites them and destroys the
     * rng-ordering guard they exist to hold. So the zone is pinned here rather than
     * documented: a lock that only holds in one timezone is not a lock.
     *
     * UTC specifically, not an IANA name: Node on Windows ignores `TZ=Europe/Berlin` and
     * friends, so a named zone would silently do nothing on half the machines this repo
     * runs on. Node re-reads process.env.TZ on assignment (>= 16), and `pool: 'forks'`
     * means each worker gets this before it touches Date.
     */
    env: { TZ: 'UTC' },
  },
});
