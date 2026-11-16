import { Activity, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { RunDetail } from "./components/RunDetail.js";
import { RunList } from "./components/RunList.js";

export function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const hash = window.location.hash.replace(/^#/, "");
    return hash || null;
  });

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "");
      setSelectedRunId(hash || null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleSelectRun = (id: string) => {
    window.location.hash = id;
    setSelectedRunId(id);
  };

  const handleBack = () => {
    window.location.hash = "";
    setSelectedRunId(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Navigation Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-2.5 cursor-pointer text-left bg-transparent border-none p-0"
          >
            <div className="p-1.5 rounded-lg bg-purple-600/20 border border-purple-500/40 text-purple-400">
              <GitBranch className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold text-base tracking-tight text-slate-100">Durable</span>
              <span className="text-xs ml-2 px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-medium border border-slate-700">
                Workflow Inspector
              </span>
            </div>
          </button>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              API Connected
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {selectedRunId ? (
          <RunDetail runId={selectedRunId} onBack={handleBack} onSelectRun={handleSelectRun} />
        ) : (
          <RunList onSelectRun={handleSelectRun} />
        )}
      </main>

      <footer className="border-t border-slate-800/60 py-4 px-6 text-center text-xs text-slate-500">
        Durable Workflow Engine &copy; 2026 &bull; Milestone 5b Inspector Dashboard
      </footer>
    </div>
  );
}
