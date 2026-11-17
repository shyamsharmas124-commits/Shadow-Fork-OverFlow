import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { RunDetail, RunSummary } from "../types.js";

interface LineageGraphProps {
  run: RunDetail;
  onSelectRun: (id: string) => void;
  allRuns?: RunSummary[];
}

export function LineageGraph({ run, onSelectRun, allRuns = [] }: LineageGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

    // Find all runs related to the current run family
    // 1. Identify root
    let rootId = run.id;
    if (run.parentRunId) {
      let currParent: string | null = run.parentRunId;
      while (currParent) {
        rootId = currParent;
        const parentSummary = allRuns.find((r) => r.id === currParent);
        currParent = parentSummary?.parentRunId ?? null;
      }
    }

    // 2. Collect all runs in this lineage tree (all descendants of rootId, plus root)
    const treeRuns: Map<
      string,
      {
        id: string;
        parentId: string | null;
        forkedFromSeq: number | null;
        status: string;
        mode: string;
      }
    > = new Map();

    // Add root
    const rootSummary = allRuns.find((r) => r.id === rootId);
    treeRuns.set(rootId, {
      id: rootId,
      parentId: rootSummary?.parentRunId ?? null,
      forkedFromSeq: rootSummary?.forkedFromSeq ?? null,
      status: rootSummary?.status ?? (run.id === rootId ? run.status : "completed"),
      mode: rootSummary?.mode ?? (run.id === rootId ? run.mode : "live"),
    });

    // Add current run if not present
    if (!treeRuns.has(run.id)) {
      treeRuns.set(run.id, {
        id: run.id,
        parentId: run.parentRunId,
        forkedFromSeq: run.forkedFromSeq,
        status: run.status,
        mode: run.mode,
      });
    }

    // Add all forks from allRuns that belong to this tree
    let addedMore = true;
    while (addedMore) {
      addedMore = false;
      for (const r of allRuns) {
        if (r.parentRunId && treeRuns.has(r.parentRunId) && !treeRuns.has(r.id)) {
          treeRuns.set(r.id, {
            id: r.id,
            parentId: r.parentRunId,
            forkedFromSeq: r.forkedFromSeq,
            status: r.status,
            mode: r.mode,
          });
          addedMore = true;
        }
      }
    }

    // Group runs by depth in tree for hierarchical positioning
    const depths = new Map<string, number>();
    depths.set(rootId, 0);

    const computeDepth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const item = treeRuns.get(id);
      if (!item?.parentId) {
        depths.set(id, 0);
        return 0;
      }
      const d = computeDepth(item.parentId) + 1;
      depths.set(id, d);
      return d;
    };

    for (const id of treeRuns.keys()) {
      computeDepth(id);
    }

    // Group runs by depth
    const levels = new Map<number, string[]>();
    for (const [id, d] of depths.entries()) {
      const arr = levels.get(d) ?? [];
      arr.push(id);
      levels.set(d, arr);
    }

    // Position nodes based on level and index within level
    const X_GAP = 280;
    const Y_GAP = 120;

    for (const [d, ids] of levels.entries()) {
      const totalInLevel = ids.length;
      ids.forEach((id, idx) => {
        const item = treeRuns.get(id)!;
        const isCurrent = id === run.id;
        const isRoot = id === rootId;

        const x = 40 + d * X_GAP;
        const y = 30 + (idx - (totalInLevel - 1) / 2) * Y_GAP + (totalInLevel > 1 ? 60 : 35);

        n.push({
          id,
          position: { x, y: Math.max(y, 20) },
          className: "!bg-transparent !border-0 !p-0 !shadow-none",
          data: {
            label: (
              <button
                type="button"
                data-testid={`tree-node-${id}`}
                onClick={() => onSelectRun(id)}
                className={`p-2.5 text-left w-56 font-mono text-[var(--ink-primary)] transition-colors cursor-pointer ${
                  isCurrent
                    ? "bg-[var(--bg-panel)] border-2 border-[var(--ink-primary)] ring-1 ring-[var(--ink-primary)]"
                    : "bg-[var(--bg-panel)] border border-[var(--border-hairline)] hover:border-[var(--ink-primary)]"
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-bold">
                  <span
                    className={
                      isCurrent ? "text-[var(--ink-primary)]" : "text-[var(--ink-secondary)]"
                    }
                  >
                    {isCurrent ? "CURRENT RUN" : isRoot ? "ROOT RUN (LIVE)" : "SHADOW FORK"}
                  </span>
                  <span className="px-1 py-0.2 bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] text-[9px] uppercase">
                    {item.mode}
                  </span>
                </div>
                <div className="text-xs font-mono font-bold truncate mt-0.5">{id}</div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block w-2 h-2 ${
                        item.status === "completed"
                          ? "bg-[#1E5A36] dark:bg-[#4EAD75]"
                          : item.status === "failed"
                            ? "bg-[#B91C1C] dark:bg-[#F87171]"
                            : "bg-[#92400E] dark:bg-[#FBBF24]"
                      }`}
                    />
                    <span className="text-[11px] text-[var(--ink-secondary)] capitalize">
                      {item.status}
                    </span>
                  </div>
                  {item.forkedFromSeq !== null && (
                    <span className="text-[10px] text-[var(--ink-muted)]">
                      @Seq {item.forkedFromSeq}
                    </span>
                  )}
                </div>
              </button>
            ),
          },
          type: "default",
        });

        if (item.parentId) {
          e.push({
            id: `e-${item.parentId}-${id}`,
            source: item.parentId,
            target: id,
            label: item.forkedFromSeq !== null ? `@Seq ${item.forkedFromSeq}` : "Fork",
            labelStyle: {
              fill: "var(--ink-primary)",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
            },
            labelBgStyle: {
              fill: "var(--bg-panel)",
              stroke: "var(--border-hairline)",
              strokeWidth: 1,
            },
            labelBgPadding: [6, 4],
            className: "animate-edge-draw",
            style: {
              stroke: isCurrent ? "var(--ink-primary)" : "var(--status-shadow-fg)",
              strokeWidth: isCurrent ? 2 : 1.5,
            },
            animated: true,
          });
        }
      });
    }

    return { nodes: n, edges: e };
  }, [run, onSelectRun, allRuns]);

  return (
    <div
      data-testid="lineage-graph-container"
      className="w-full h-72 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] overflow-hidden relative"
    >
      <div className="absolute top-2 left-2 z-10 text-[10px] font-mono font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
        Fork Tree &amp; Execution Lineage ({nodes.length} connected run
        {nodes.length === 1 ? "" : "s"})
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        nodesDraggable={true}
        zoomOnScroll={false}
        panOnDrag={false}
      >
        <Background color="var(--border-hairline)" gap={16} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-[var(--bg-panel)] !border-[var(--border-hairline)] !rounded-none !shadow-none [&>button]:!bg-[var(--bg-panel)] [&>button]:!border-[var(--border-hairline)] [&>button]:!fill-[var(--ink-primary)] hover:[&>button]:!bg-[var(--bg-hover)]"
        />
      </ReactFlow>
    </div>
  );
}
