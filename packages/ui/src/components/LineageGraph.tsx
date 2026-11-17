import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { RunDetail } from "../types.js";

interface LineageGraphProps {
  run: RunDetail;
  onSelectRun: (id: string) => void;
}

export function LineageGraph({ run, onSelectRun }: LineageGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

    if (run.parentRunId) {
      // Parent Node (remains stable)
      n.push({
        id: run.parentRunId,
        position: { x: 40, y: 65 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none",
        data: {
          label: (
            <button
              type="button"
              className="p-2.5 bg-[var(--bg-panel)] border border-[var(--border-hairline)] hover:border-[var(--ink-primary)] cursor-pointer text-left w-56 font-mono transition-colors text-[var(--ink-primary)]"
              onClick={() => onSelectRun(run.parentRunId!)}
            >
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
                Parent Run (Live)
              </div>
              <div className="text-xs font-mono font-bold truncate mt-0.5">{run.parentRunId}</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 bg-[#1E5A36] dark:bg-[#4EAD75]" />
                <span className="text-[11px] text-[var(--ink-secondary)]">Live Execution</span>
              </div>
            </button>
          ),
        },
        type: "default",
      });

      // Current Child Node (Shadow Fork - draws out)
      n.push({
        id: run.id,
        position: { x: 380, y: 65 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none animate-fadeIn",
        data: {
          label: (
            <div className="p-2.5 bg-[var(--bg-panel)] border-2 border-[var(--ink-primary)] text-left w-56 font-mono text-[var(--ink-primary)]">
              <div className="text-[10px] font-bold text-[var(--ink-primary)] flex items-center justify-between">
                <span>CURRENT RUN</span>
                <span className="px-1 py-0.2 bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] text-[9px]">
                  SHADOW
                </span>
              </div>
              <div className="text-xs font-mono font-bold truncate mt-0.5">{run.id}</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 ${
                    run.status === "completed"
                      ? "bg-[#1E5A36] dark:bg-[#4EAD75]"
                      : run.status === "failed"
                        ? "bg-[#B91C1C] dark:bg-[#F87171]"
                        : "bg-[#92400E] dark:bg-[#FBBF24]"
                  }`}
                />
                <span className="text-[11px] text-[var(--ink-secondary)] capitalize">
                  {run.status} (shadow fork)
                </span>
              </div>
            </div>
          ),
        },
        type: "default",
      });

      // Lineage edge with animated SVG edge stroke-dashoffset
      e.push({
        id: `e-${run.parentRunId}-${run.id}`,
        source: run.parentRunId,
        target: run.id,
        label: run.forkedFromSeq !== null ? `Forked @ Seq ${run.forkedFromSeq}` : "Shadow Fork",
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
        style: { stroke: "var(--status-shadow-fg)", strokeWidth: 1.5 },
        animated: true,
      });
    } else {
      // Root live run node
      n.push({
        id: run.id,
        position: { x: 200, y: 65 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none",
        data: {
          label: (
            <div className="p-2.5 bg-[var(--bg-panel)] border border-[var(--border-hairline)] text-left w-60 font-mono text-[var(--ink-primary)]">
              <div className="text-[10px] font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
                Root Run (No Parent)
              </div>
              <div className="text-xs font-mono font-bold truncate mt-0.5">{run.id}</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 ${
                    run.status === "completed"
                      ? "bg-[#1E5A36] dark:bg-[#4EAD75]"
                      : run.status === "failed"
                        ? "bg-[#B91C1C] dark:bg-[#F87171]"
                        : "bg-[#92400E] dark:bg-[#FBBF24]"
                  }`}
                />
                <span className="text-[11px] text-[var(--ink-secondary)] capitalize">
                  {run.status} ({run.mode})
                </span>
              </div>
            </div>
          ),
        },
        type: "default",
      });
    }

    return { nodes: n, edges: e };
  }, [run, onSelectRun]);

  return (
    <div
      data-testid="lineage-graph-container"
      className="w-full h-60 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] overflow-hidden relative"
    >
      <div className="absolute top-2 left-2 z-10 text-[10px] font-mono font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
        Execution Lineage & Fork Graph
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.25 }}
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
