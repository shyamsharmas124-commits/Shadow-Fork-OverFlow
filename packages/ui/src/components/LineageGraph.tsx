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
      // Parent Node
      n.push({
        id: run.parentRunId,
        position: { x: 50, y: 80 },
        data: {
          label: (
            <button
              type="button"
              className="p-3 bg-slate-900 border border-slate-700 rounded-lg shadow cursor-pointer hover:border-slate-500 text-left w-full"
              onClick={() => onSelectRun(run.parentRunId!)}
            >
              <div className="text-xs font-semibold text-slate-400">Parent Run</div>
              <div className="text-sm font-mono text-slate-200 truncate max-w-[160px]">
                {run.parentRunId}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-xs text-slate-300">Live Base</span>
              </div>
            </button>
          ),
        },
        type: "default",
      });

      // Current Node (Fork)
      n.push({
        id: run.id,
        position: { x: 340, y: 80 },
        data: {
          label: (
            <div className="p-3 bg-purple-950/60 border border-purple-500 rounded-lg shadow-lg text-left">
              <div className="text-xs font-semibold text-purple-300 flex items-center justify-between">
                <span>Current Run</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-900 text-purple-200">
                  SHADOW
                </span>
              </div>
              <div className="text-sm font-mono text-slate-100 truncate max-w-[160px]">
                {run.id}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    run.status === "completed"
                      ? "bg-emerald-500"
                      : run.status === "failed"
                        ? "bg-rose-500"
                        : "bg-amber-500"
                  }`}
                />
                <span className="text-xs text-slate-300 capitalize">{run.status}</span>
              </div>
            </div>
          ),
        },
        type: "default",
      });

      // Lineage edge
      e.push({
        id: `e-${run.parentRunId}-${run.id}`,
        source: run.parentRunId,
        target: run.id,
        label: run.forkedFromSeq !== null ? `Forked @ Seq ${run.forkedFromSeq}` : "Shadow Fork",
        style: { stroke: "#a855f7", strokeWidth: 2 },
        animated: true,
      });
    } else {
      // Root live run node
      n.push({
        id: run.id,
        position: { x: 180, y: 80 },
        data: {
          label: (
            <div className="p-3 bg-slate-900 border border-slate-700 rounded-lg shadow text-left">
              <div className="text-xs font-semibold text-slate-400">Root Run (No Parent)</div>
              <div className="text-sm font-mono text-slate-200 truncate max-w-[180px]">
                {run.id}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    run.status === "completed"
                      ? "bg-emerald-500"
                      : run.status === "failed"
                        ? "bg-rose-500"
                        : "bg-amber-500"
                  }`}
                />
                <span className="text-xs text-slate-300 capitalize">
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
    <div className="w-full h-56 bg-slate-950/80 rounded-lg border border-slate-800 overflow-hidden relative">
      <div className="absolute top-2 left-3 z-10 text-xs font-medium text-slate-400">
        Run Lineage & Fork Graph
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        nodesDraggable={true}
        zoomOnScroll={false}
        panOnDrag={false}
      >
        <Background color="#334155" gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
