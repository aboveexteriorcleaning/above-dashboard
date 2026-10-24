import Link from "next/link";
import { redirect } from "next/navigation";
import { getFreshness, getSession, type Role, type Session } from "@/lib/data";
import { timeAgo } from "@/lib/format";

type Page = "overview" | "team" | "me";

/** Gate for a page: signed in, set up by an owner, and allowed this page. */
export async function requireSession(allow: Role[]): Promise<Session & { role: Role }> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!s.linked || !s.role) redirect("/not-set-up");
  if (!allow.includes(s.role)) redirect("/");
  return s as Session & { role: Role };
}

export async function Shell({ page, session, children }: { page: Page; session: Session & { role: Role }; children: React.ReactNode }) {
  const fresh = await getFreshness();
  const stale = !fresh.healthy || !fresh.last_synced || Date.now() - new Date(fresh.last_synced).getTime() > 60 * 60_000;
  const links: { href: string; key: Page; label: string }[] = session.role === "owner"
    ? [{ href: "/overview", key: "overview", label: "Overview" }, { href: "/team", key: "team", label: "Team" }, { href: "/me", key: "me", label: "My stats" }]
    : [{ href: "/me", key: "me", label: "My stats" }];

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="wordmark">ABOVE</Link>
        <nav className="nav" aria-label="Main">
          {links.map((l) => <Link key={l.key} href={l.href} aria-current={l.key === page ? "page" : undefined}>{l.label}</Link>)}
        </nav>
        <div className="topbar-end small muted">
          <span className="fresh" title={fresh.last_synced ? new Date(fresh.last_synced).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : ""}>
            <span className={`dot${stale ? " stale" : ""}`} aria-hidden />
            {stale ? "Data may be out of date" : `Updated ${timeAgo(fresh.last_synced)}`}
          </span>
          <form action="/auth/signout" method="post"><button className="linkbtn">Sign out</button></form>
        </div>
      </header>
      {children}
    </div>
  );
}
