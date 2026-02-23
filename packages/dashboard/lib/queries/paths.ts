import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { PathLink } from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
}

export async function queryPathSequences(
  ctx: QueryContext,
  startTool?: string,
  endTool?: string,
): Promise<{ links: PathLink[]; nodes: string[] }> {
  const startFilter = startTool ? " AND source = {startTool:String}" : "";
  const endFilter = endTool ? " AND target = {endTool:String}" : "";

  const rows = await queryAnalytics<PathLink>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ordered AS (
        SELECT
          session_id,
          event_name,
          timestamp,
          lagInFrame(event_name) OVER (
            PARTITION BY session_id
            ORDER BY timestamp
            ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
          ) AS prev_tool
        FROM events
        WHERE project_id = {projectId:String}
          AND event_type = 'tool_call'
          AND event_name IS NOT NULL
          AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      )
      SELECT
        prev_tool AS source,
        event_name AS target,
        count() AS value
      FROM ordered
      WHERE prev_tool IS NOT NULL AND prev_tool != event_name
        ${startFilter}${endFilter}
      GROUP BY source, target
      ORDER BY value DESC
      LIMIT 50
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...(startTool ? { startTool } : {}),
      ...(endTool ? { endTool } : {}),
    },
  });

  const nodeSet = new Set<string>();
  for (const row of rows) {
    nodeSet.add(row.source);
    nodeSet.add(row.target);
  }

  return {
    links: rows.map((r) => ({
      source: r.source,
      target: r.target,
      value: Number(r.value),
    })),
    nodes: Array.from(nodeSet),
  };
}
