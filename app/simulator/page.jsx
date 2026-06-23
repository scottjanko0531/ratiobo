"use client";
import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import RegimeSimulator from "../../components/RegimeSimulator";
import { getAssetData } from "../../lib/data/assetReturns";

export default function SimulatorPage() {
  const [assetData, setAssetData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getAssetData()
      .then(setAssetData)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Regime Simulator</h1>
        <p className="label mt-1">Macro regime · Risk parity · Leverage</p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-loss/10 border border-loss/20 text-loss text-sm">
          {error}
        </div>
      )}

      {!assetData ? (
        <div className="flex justify-center py-16">
          <span className="flex items-center gap-1.5" aria-label="Loading">
            <span className="bead animate-pulse" />
            <span className="bead animate-pulse [animation-delay:150ms]" />
            <span className="bead animate-pulse [animation-delay:300ms]" />
          </span>
        </div>
      ) : (
        <RegimeSimulator assets={assetData.assets} corrMatrix={assetData.corrMatrix} />
      )}
    </Shell>
  );
}
