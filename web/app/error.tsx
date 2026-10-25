"use client";
import { useEffect } from "react";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="shell" style={{ paddingTop: 64 }}>
      <div className="panel" style={{ maxWidth: "60ch" }}>
        <h1 style={{ fontSize: "1.5rem" }}>This page didn&rsquo;t load</h1>
        <p className="muted">Something went wrong getting the numbers. Try again, or pick a shorter period. If it keeps happening, the code below helps track it down.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" onClick={() => reset()}>Try again</button>
          <a className="btn quiet" href="/">Back to the dashboard</a>
          {error.digest && <span className="small muted">Code: {error.digest}</span>}
        </div>
      </div>
    </main>
  );
}
