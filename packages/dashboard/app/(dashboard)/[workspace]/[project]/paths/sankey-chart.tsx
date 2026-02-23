"use client";

import type { PathLink } from "@/lib/queries/types";
import { ResponsiveSankey } from "@nivo/sankey";

interface SankeyChartProps {
  links: PathLink[];
  nodes: string[];
}

export default function SankeyChart({ links, nodes }: SankeyChartProps) {
  const sankeyData = {
    nodes: nodes.map((id) => ({ id })),
    links: links.map((l) => ({
      source: l.source,
      target: l.target,
      value: l.value,
    })),
  };

  return (
    <div className="h-96" aria-label="Tool call path visualization">
      <ResponsiveSankey
        data={sankeyData}
        margin={{ top: 20, right: 160, bottom: 20, left: 160 }}
        align="justify"
        colors={{ scheme: "greys" }}
        nodeOpacity={1}
        nodeHoverOthersOpacity={0.35}
        nodeThickness={18}
        nodeSpacing={24}
        nodeBorderWidth={0}
        nodeBorderColor={{ from: "color", modifiers: [["darker", 0.8]] }}
        linkOpacity={0.3}
        linkHoverOthersOpacity={0.1}
        linkContract={3}
        enableLinkGradient
        labelPosition="outside"
        labelOrientation="horizontal"
        labelPadding={16}
        labelTextColor={{ from: "color", modifiers: [["darker", 1]] }}
        animate={false}
      />
    </div>
  );
}
