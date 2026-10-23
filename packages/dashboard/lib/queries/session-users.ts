import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import { COUNTED_SESSION } from "./users";

interface QueryContext {
  workspaceId: string;
  projectId: string;
}

/**
 * The first user_id identified in each of these sessions (#145) — the
 * session step of the Users page's key (keyedEvents in users.ts), for the
 * lists that show one row per event: the invocation feed and a tool's
 * recent invocations. One query over the page's session ids instead of a
 * join under every row of the range.
 *
 * Same rule as the key: identify rows with a non-empty user_id, the first
 * by (timestamp, event_id), never for an empty session_id nor a
 * `per_request` one (#144, see keyedEvents in users.ts). Unbounded in
 * time, like the stitch for a named person: a conversation identified
 * before the selected range still names its user. The live feed shows the
 * raw user_id and is not stitched.
 */
export async function querySessionUsers(
  ctx: QueryContext,
  sessionIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const bySession = new Map<string, string>();
  const ids = [
    ...new Set(sessionIds.filter((id): id is string => typeof id === "string" && id !== "")),
  ];
  if (ids.length === 0) return bySession;

  const rows = await queryAnalytics<{ sessionId: string; userId: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT session_id AS sessionId,
             argMin(assumeNotNull(user_id), (timestamp, event_id)) AS userId
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'identify'
        AND user_id IS NOT NULL AND user_id != ''
        AND ${COUNTED_SESSION}
        AND session_id IN {sessionIds:Array(String)}
      GROUP BY session_id
    `,
    params: { projectId: ctx.projectId, sessionIds: ids },
  });

  for (const r of rows) bySession.set(r.sessionId, r.userId);
  return bySession;
}
