import type { Repos } from './repositories.js';

/**
 * One-time back-fill of the roster from campaign data that already proves a connection:
 *
 *  - `accepted` / `replied` profiles — acceptance or a reply confirmed it directly.
 *  - message-kind profiles that reached `sent` — the sender's live 1st-degree gate
 *    (`classifyRelationship` + `mayReceiveDirectMessage`) had to pass before a DM could go
 *    out, so a sent message is itself proof of connection.
 *
 * Everything else is excluded. In particular a `sent` INVITE is a pending request, not a
 * connection, and seeding it would manufacture a connection that may never exist.
 *
 * Runs at most once, gated on `app_state.connections_seeded_at` — which is stamped even
 * when nothing was inserted, so an empty database does not retry on every boot. Uses
 * INSERT OR IGNORE so a roster already populated by an import always wins: this is a
 * back-fill, not a source of truth. Returns the number of rows inserted.
 */
export function seedConnectionsFromProfiles(repos: Repos, nowIso: string): number {
  if (repos.appState.get().connections_seeded_at) return 0;

  // MIN/MAX ignore NULLs, which is exactly what we want when one person has both an
  // invite row (carrying accepted_at) and a message row (carrying the better full_name).
  const info = repos.db.prepare(`
    INSERT OR IGNORE INTO connections
      (profile_url, full_name, first_name, connected_on, source, first_seen_at, last_seen_at)
    SELECT
      profile_url,
      MAX(full_name),
      MAX(first_name),
      date(MIN(accepted_at)),
      'migration', ?, ?
    FROM profiles
    WHERE status IN ('accepted', 'replied')
       OR (kind = 'message' AND status IN ('sent', 'replied'))
    GROUP BY profile_url
  `).run(nowIso, nowIso);

  repos.appState.setConnectionsSeeded(nowIso);
  return Number(info.changes);
}
