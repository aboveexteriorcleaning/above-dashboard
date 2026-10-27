"use client";

import { useFormStatus } from "react-dom";

// A submit button that shows it's working and can't be pressed twice.
export function SubmitButton({ children, pending = "Saving…", className = "btn" }: { children: React.ReactNode; pending?: string; className?: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={busy} aria-busy={busy}>
      {busy ? <><span className="spinner" aria-hidden />{pending}</> : children}
    </button>
  );
}
