import Link from "next/link";
import { redirect } from "next/navigation";
import { getFreshness, getSession, type Role, type Session } from "@/lib/data";
import { timeAgo } from "@/lib/format";

type Page = "overview" | "leads" | "ads" | "sales" | "crews" | "quality" | "plans" | "upsells" | "customers" | "financial" | "team" | "me";

type Group = { key: string; label: string; pages: { key: Page; href: string; label: string }[] };
/** Owner navigation, grouped the way the KPI blueprint is organised. */
const OWNER_GROUPS: Group[] = [
  { key: "overview", label: "Overview", pages: [{ key: "overview", href: "/overview", label: "Overview" }] },
  { key: "growth", label: "Growth", pages: [
    { key: "leads", href: "/leads", label: "Leads" }, { key: "ads", href: "/ads", label: "Ads" }, { key: "sales", href: "/sales", label: "Sales & quotes" }] },
  { key: "operations", label: "Operations", pages: [
    { key: "crews", href: "/crews", label: "Crew economics" }, { key: "quality", href: "/quality", label: "Quality" }] },
  { key: "revenue", label: "Revenue", pages: [
    { key: "plans", href: "/plans", label: "Plans" }, { key: "upsells", href: "/upsells", label: "Upsells" }, { key: "customers", href: "/customers", label: "Customers" }] },
  { key: "financial", label: "Financial", pages: [{ key: "financial", href: "/financial", label: "Financial" }] },
  { key: "team", label: "Team", pages: [{ key: "team", href: "/team", label: "Team" }] },
  { key: "me", label: "My stats", pages: [{ key: "me", href: "/me", label: "My stats" }] },
];
const CREW_GROUPS: Group[] = [{ key: "me", label: "My stats", pages: [{ key: "me", href: "/me", label: "My stats" }] }];

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
  const groups = session.role === "owner" ? OWNER_GROUPS : CREW_GROUPS;
  const current = groups.find((g) => g.pages.some((p) => p.key === page));

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="wordmark" aria-label="Above Exterior Cleaning, home">
          {/* White lettering for dark mode, navy for light mode */}
          <picture>
            <source srcSet="/logo-dark.png" media="(prefers-color-scheme: dark)" />
            <img src="/logo-light.png" alt="Above Exterior Cleaning" width={351} height={132} />
          </picture>
        </Link>
        <nav className="nav" aria-label="Main">
          {groups.map((g) => <Link key={g.key} href={g.pages[0].href} aria-current={g === current ? "page" : undefined}>{g.label}</Link>)}
        </nav>
        <div className="topbar-end small muted">
          <span className="fresh" title={fresh.last_synced ? new Date(fresh.last_synced).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : ""}>
            <span className={`dot${stale ? " stale" : ""}`} aria-hidden />
            {stale ? "Data may be out of date" : `Updated ${timeAgo(fresh.last_synced)}`}
          </span>
          <form action="/auth/signout" method="post"><button className="linkbtn">Sign out</button></form>
        </div>
      </header>
      {current && current.pages.length > 1 && (
        <nav className="subnav" aria-label={`${current.label} pages`}>
          {current.pages.map((p) => <Link key={p.key} href={p.href} aria-current={p.key === page ? "page" : undefined}>{p.label}</Link>)}
        </nav>
      )}
      {children}
    </div>
  );
}
