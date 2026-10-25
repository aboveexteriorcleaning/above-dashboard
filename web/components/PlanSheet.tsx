"use client";
import { useMemo, useState } from "react";
import type { PlanCustomer, PlanStatus } from "@/lib/data";
import { jobberClientUrl, jobberJobUrl } from "@/lib/jobber-links";

export const STATUS: Record<PlanStatus, { label: string; tone: "good" | "warn" | "bad" | "off"; rank: number; help: string }> = {
  overdue:     { label: "Overdue, not booked", tone: "bad",  rank: 0, help: "Past the due date and grace period with no visit booked" },
  not_booked:  { label: "Not booked",          tone: "warn", rank: 1, help: "No next visit on the schedule yet" },
  needs_date:  { label: "Needs a date",        tone: "warn", rank: 2, help: "Next job exists but has no visit date" },
  booked_late: { label: "Booked late",         tone: "warn", rank: 3, help: "Next visit is booked after the due date plus grace" },
  on_schedule: { label: "On schedule",         tone: "good", rank: 4, help: "Next visit is booked on time" },
  lapsed:      { label: "Lapsed",              tone: "off",  rank: 5, help: "More than 6 months past due with nothing booked" },
};
const ATTENTION: PlanStatus[] = ["overdue", "not_booked", "needs_date", "booked_late"];

type Filter = "attention" | "on_schedule" | "lapsed" | "all";
type SortKey = "sold_by" | "status" | "client_name" | "plan_name" | "last_visit" | "next_visit" | "due_date" | "visits_done" | "revenue_to_date" | "annual_value";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const day = (d: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

export function PlanSheet({ rows }: { rows: PlanCustomer[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });

  const counts = useMemo(() => ({
    attention: rows.filter((r) => ATTENTION.includes(r.status)).length,
    on_schedule: rows.filter((r) => r.status === "on_schedule").length,
    lapsed: rows.filter((r) => r.status === "lapsed").length,
    all: rows.length,
  }), [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) =>
      (filter === "all" || (filter === "attention" ? ATTENTION.includes(r.status) : r.status === filter)) &&
      (!needle || [r.client_name, r.street, r.city, r.plan_name, r.phone, r.sold_by].some((v) => v?.toLowerCase().includes(needle))));
    const val = (r: PlanCustomer): string | number => {
      if (sort.key === "status") return STATUS[r.status].rank * 100000 - r.days_overdue;
      const v = r[sort.key];
      return v == null ? (sort.dir === 1 ? "￿" : "") : typeof v === "string" ? v.toLowerCase() : v;
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, filter, q, sort]);

  const th = (key: SortKey, label: string, num = false) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="sortbtn" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (num ? -1 : 1) }))}>
        {label}{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  function downloadCsv() {
    const head = ["Customer", "Phone", "Email", "Address", "City", "Plan", "Visits per year", "Status", "Last visit", "Next visit", "Next job #", "Due by", "Days overdue", "Sold by", "How sold", "Sold on", "Visits done", "Plan revenue to date", "Visit value", "Annual value"];
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = shown.map((r) => [r.client_name, r.phone, r.email, r.street, r.city, r.plan_name, r.services_per_year, STATUS[r.status].label,
      r.last_visit, r.next_visit, r.next_job_number, r.due_date, r.days_overdue || "", r.sold_by, r.sale_channel === "on_site" ? "On site" : r.sale_channel === "pre_job" ? "Before the job" : "", r.sold_on, r.visits_done, r.revenue_to_date, r.visit_value, r.annual_value].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `plan-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" }, { key: "attention", label: "Needs attention" },
    { key: "on_schedule", label: "On schedule" }, { key: "lapsed", label: "Lapsed" },
  ];

  return (
    <div>
      <div className="sheet-tools">
        <div className="chips" role="group" aria-label="Show">
          {chips.map((c) => (
            <button key={c.key} className="chip" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>
              {c.label} <span className="chip-n">{counts[c.key]}</span>
            </button>
          ))}
        </div>
        <div className="sheet-actions">
          <label className="sr-only" htmlFor="plan-search">Search plan customers</label>
          <input id="plan-search" type="search" placeholder="Search name, address, plan" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn quiet" onClick={downloadCsv}>Download CSV</button>
        </div>
      </div>
      <div className="sheet-wrap">
        <table className="rows sheet">
          <thead><tr>
            {th("client_name", "Customer")}
            {th("plan_name", "Plan")}
            {th("status", "Status")}
            {th("last_visit", "Last visit")}
            {th("due_date", "Due by")}
            {th("next_visit", "Next visit")}
            {th("sold_by", "Sold by")}
            {th("visits_done", "Visits", true)}
            {th("revenue_to_date", "Revenue to date", true)}
            {th("annual_value", "Annual value", true)}
          </tr></thead>
          <tbody>
            {shown.map((r) => {
              const s = STATUS[r.status];
              const clientUrl = jobberClientUrl(r.client_id), jobUrl = jobberJobUrl(r.next_job_id);
              return (
                <tr key={r.home_key + r.service_line} className={s.tone === "off" ? "dim" : undefined}>
                  <td>
                    <div className="cell-strong">{clientUrl ? <a href={clientUrl} target="_blank" rel="noreferrer">{r.client_name ?? "Unnamed"}</a> : (r.client_name ?? "Unnamed")}</div>
                    <div className="small muted">{[r.street, r.city].filter(Boolean).join(", ")}{r.phone ? ` · ${r.phone}` : ""}</div>
                  </td>
                  <td><div>{r.plan_name.replace(/ Cleaning Plan$| Plan$/, "")}</div><div className="small muted">{r.services_per_year}× a year</div></td>
                  <td>
                    <span className={`status ${s.tone}`} title={s.help}>{s.label}</span>
                    {r.status === "overdue" || r.status === "lapsed" ? <div className="small muted">{r.days_overdue} days past due</div> : null}
                  </td>
                  <td className="date">{day(r.last_visit)}</td>
                  <td className="date">{day(r.due_date)}</td>
                  <td className="date">
                    {r.next_visit ? (jobUrl ? <a href={jobUrl} target="_blank" rel="noreferrer">{day(r.next_visit)}</a> : day(r.next_visit)) : <span className="muted">—</span>}
                    {r.next_job_number ? <div className="small muted">Job #{r.next_job_number}</div> : null}
                  </td>
                  <td>
                    <div>{r.sold_by ?? <span className="muted">Unknown</span>}</div>
                    {r.sale_channel ? <div className="small muted">{r.sale_channel === "on_site" ? "On site" : "Before the job"}{r.sold_on ? `, ${day(r.sold_on)}` : ""}</div> : null}
                  </td>
                  <td className="num">{r.visits_done}</td>
                  <td className="num">{usd.format(r.revenue_to_date)}</td>
                  <td className="num">{r.annual_value ? usd.format(r.annual_value) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={10} className="muted">No plan customers match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ maxWidth: "75ch" }}>
        One row per address and plan, so duplicate client records in Jobber show once. Due by is the last plan visit plus one plan cycle.
        A home is flagged when its next plan visit isn&rsquo;t on the schedule, or is booked more than 30 days after it&rsquo;s due.
        Names and dates link to Jobber.
      </p>
    </div>
  );
}
