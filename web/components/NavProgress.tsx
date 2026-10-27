"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Shows that a click went through: a thin bar across the top while the next page
// loads, the clicked link marked as loading, and (after a short pause, so quick
// loads don't flicker) the current page faded slightly. Clears when the new page
// arrives, or after 20 seconds as a safety net.
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    setBusy(false);
    document.documentElement.classList.remove("is-navigating");
    document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
    if (timer.current) clearTimeout(timer.current);
  };

  // New page arrived.
  useEffect(() => {
    stop();
    document.querySelectorAll("details.custom-range[open]").forEach((d) => d.removeAttribute("open"));
  }, [pathname, search]);

  useEffect(() => {
    const start = (el?: Element | null) => {
      setBusy(true);
      document.documentElement.classList.add("is-navigating");
      el?.setAttribute("data-pending", "");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(stop, 20000);
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;   // same page or #anchor
      start(a);
    };
    const onSubmit = (e: SubmitEvent) => {
      if (e.defaultPrevented) return;
      start(e.submitter ?? (e.target as Element));
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("pageshow", stop);   // back/forward cache
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("pageshow", stop);
    };
  }, []);

  return <div className={`nav-progress${busy ? " on" : ""}`} role="progressbar" aria-hidden={!busy} aria-label="Loading" />;
}
