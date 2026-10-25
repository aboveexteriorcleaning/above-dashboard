"use client";
import { useMemo, useState } from "react";
import type { Lead } from "@/lib/data";
import { jobberClientUrl } from "@/lib/jobber-links";

type Filter = "all" | "no_reply" | "follow_up" | "not_quoted" | "quoted" | "booked";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }) : "—";
const phone = (p: string) => { const d = p.replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };
function mins(m: number | null) {
  if (m == null) return "—";
  if (m < 1) return "under 1 min";
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 2880) return `${Math.round(m / 6) / 10} hr`;
  return `${Math.round(m / 144) / 10} days`;
}
const stage = (l: Lead) => l.booked_at ? "booked" : l.quoted_at ? "quoted" : l.first_response_at ? "replied" : l.waiting_on_them ? "waiting_them" : "no_reply";

export function LeadSheet({ rows }: { rows: Lead[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => ({
    all: rows.length,
    no_reply: rows.filter((r) => !r.first_response_at && !r.waiting_on_them).length,
    follow_up: rows.filter((r) => r.follow_up?.endsWith("due")).length,
    not_quoted: rows.filter((r) => !r.quoted_at && !r.booked_at).length,
    quoted: rows.filter((r) => r.quoted_at && !r.booked_at).length,
    booked: rows.filter((r) => r.booked_at).length,
  }), [rows]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase(), digits = n.replace(/\D/g, "");
    return rows.filter((r) => {
      const okFilter = filter === "all" || (filter === "no_reply" ? !r.first_response_at && !r.waiting_on_them
        : filter === "follow_up" ? !!r.follow_up?.endsWith("due")
        : filter === "not_quoted" ? !r.quoted_at && !r.booked_at
        : filter === "quoted" ? !!r.quoted_at && !r.booked_at : !!r.booked_at);
      const okSearch = !n || r.client_name?.toLowerCase().includes(n) || r.source.toLowerCase().includes(n)
        || (digits.length >= 3 && r.contact_phone.includes(digits));
      return okFilter && okSearch;
    });
  }, [rows, filter, q]);

  function downloadCsv() {
    const head = ["Name", "Phone", "First contact", "Source", "Line", "First reply (min)", "Clock started at", "Replied by", "Follow-up", "Quoted", "Booked", "Booked value"];
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = shown.map((r) => [r.client_name, r.contact_phone, r.lead_at, r.source, r.line_name, r.response_minutes, r.clock_from, r.responded_by, r.follow_up,
      r.quoted_at?.slice(0, 10), r.booked_at?.slice(0, 10), r.booked_value].map(esc).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" }, { key: "no_reply", label: "No reply yet" }, { key: "follow_up", label: "Follow-up due" }, { key: "not_quoted", label: "Not quoted" },
    { key: "quoted", label: "Quoted" }, { key: "booked", label: "Booked" },
  ];
  const tag = { booked: ["good", "Booked"], quoted: ["warn", "Quoted"], replied: ["off", "Replied"], waiting_them: ["off", "Waiting on them"], no_reply: ["bad", "No reply yet"] } as const;

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
          <label className="sr-only" htmlFor="lead-search">Search leads</label>
          <input id="lead-search" type="search" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn quiet" onClick={downloadCsv}>Download CSV</button>
        </div>
      </div>
      <div className="sheet-wrap">
        <table className="rows sheet leads-sheet">
          <thead><tr><th>Lead</th><th>First contact</th><th>Source</th><th>Stage</th><th>First reply</th><th>Quoted</th><th className="num">Booked</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const url = jobberClientUrl(r.client_id);
              const [tone, label] = tag[stage(r)];
              const name = r.client_name && !/^New Call/i.test(r.client_name) ? r.client_name : null;
              return (
                <tr key={r.contact_phone}>
                  <td>
                    <div className="cell-strong">{name ? (url ? <a href={url} target="_blank" rel="noreferrer">{name}</a> : name) : phone(r.contact_phone)}</div>
                    {name && <div className="small muted">{phone(r.contact_phone)}</div>}
                  </td>
                  <td className="date">{when(r.lead_at)}{!r.in_hours && <div className="small muted">After hours (7pm–7am)</div>}</td>
                  <td>{r.source}{r.line_name && <div className="small muted">{r.line_name}</div>}</td>
                  <td>
                    <span className={`status ${tone}`}>{label}</span>
                    {r.follow_up && <div className={`small ${/due|Missed/.test(r.follow_up) ? "down" : "muted"}`}>{r.follow_up}</div>}
                  </td>
                  <td className="date">{mins(r.response_minutes)}{r.responded_by && <div className="small muted">{r.responded_by}{r.clock_from === "their reply" ? ", after their reply" : ""}</div>}</td>
                  <td className="date">{day(r.quoted_at)}</td>
                  <td className="num">{r.booked_at ? usd.format(r.booked_value) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="muted">No leads match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ maxWidth: "75ch" }}>
        A lead is a phone number you&rsquo;d never dealt with, that wasn&rsquo;t already a customer, and that texted in, called (20 seconds or more, or left a voicemail),
        or got the automatic form-lead text. First reply is the first time a person called or texted back, or picked up their call; the automatic text doesn&rsquo;t count, and form leads are timed from the auto-text if you reached them within 24 hours, otherwise from their reply. &ldquo;Waiting on them&rdquo; means they never answered the auto-text.
        In this list, quoted and booked come from Jobber by matching the lead&rsquo;s phone number (within 60 and 90 days), so leads with no phone on their Jobber profile show as not quoted.
      </p>
    </div>
  );
}
