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
        position: { x: 40, y: 70 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none",
        data: {
          label: (
            <button
              type="button"
              className="p-3 bg-slate-900 border border-slate-700 hover:border-slate-500 rounded-lg shadow-lg cursor-pointer text-left w-56 transition-colors"
              onClick={() => onSelectRun(run.parentRunId!)}
            >
              <div className="text-xs font-semibold text-slate-400">Parent Run</div>
              <div className="text-xs font-mono text-slate-200 truncate mt-0.5">
                {run.parentRunId}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
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
        position: { x: 380, y: 70 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none",
        data: {
          label: (
            <div className="p-3 bg-purple-950/80 border border-purple-500 rounded-lg shadow-xl text-left w-56">
              <div className="text-xs font-semibold text-purple-300 flex items-center justify-between">
                <span>Current Run</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-900 text-purple-200 font-mono">
                  SHADOW
                </span>
              </div>
              <div className="text-xs font-mono text-slate-100 truncate mt-0.5">{run.id}</div>
              <div className="mt-2 flex items-center gap-1.5">
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
        labelStyle: { fill: "#f1f5f9", fontSize: 11, fontWeight: 600, fontFamily: "monospace" },
        labelBgStyle: { fill: "#1e1b4b", fillOpacity: 0.95, rx: 6, ry: 6 },
        labelBgPadding: [8, 5],
        style: { stroke: "#c084fc", strokeWidth: 2 },
        animated: true,
      });
    } else {
      // Root live run node
      n.push({
        id: run.id,
        position: { x: 200, y: 70 },
        className: "!bg-transparent !border-0 !p-0 !shadow-none",
        data: {
          label: (
            <div className="p-3 bg-slate-900 border border-slate-700 rounded-lg shadow-lg text-left w-60">
              <div className="text-xs font-semibold text-slate-400">Root Run (No Parent)</div>
              <div className="text-xs font-mono text-slate-200 truncate mt-0.5">{run.id}</div>
              <div className="mt-2 flex items-center gap-1.5">
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
    <div
      data-testid="lineage-graph-container"
      className="w-full h-64 bg-slate-950 rounded-lg border border-slate-800 overflow-hidden relative shadow-inner"
    >
      <div className="absolute top-2.5 left-3.5 z-10 text-xs font-semibold text-slate-400 tracking-wide uppercase">
        Run Lineage & Fork Graph
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.25 }}
        nodesConnectable={false}
        nodesDraggable={true}
        zoomOnScroll={false}
        panOnDrag={false}
      >
        <Background color="#334155" gap={16} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-slate-900 !border-slate-800 !rounded-lg !shadow-lg [&>button]:!bg-slate-900 [&>button]:!border-slate-800 [&>button]:!fill-slate-300 hover:[&>button]:!bg-slate-800"
        />
      </ReactFlow>
    </div>
  );
}
