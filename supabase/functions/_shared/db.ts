// Direct Postgres connection for the sync. Runs as the database owner, so it
// is used ONLY inside these server-side functions, never from the browser.
import postgres from "npm:postgres@3.4.5";

let _sql: ReturnType<typeof postgres> | null = null;

export function db() {
  if (!_sql) {
    const url = Deno.env.get("SUPABASE_DB_URL");
    if (!url) throw new Error("SUPABASE_DB_URL missing");
    _sql = postgres(url, { max: 3, prepare: false });
  }
  return _sql;
}

/** Upsert rows into a public table, keyed by `id` (or a given key). */
export async function upsert(
  table: string,
  rows: Record<string, unknown>[],
  key: string[] = ["id"],
) {
  if (rows.length === 0) return;
  // The same record can appear twice in one batch (e.g. two jobs at one property): keep the last copy.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) byKey.set(key.map((k) => String(r[k])).join("\u0000"), r);
  rows = [...byKey.values()];
  const sql = db();
  const cols = Object.keys(rows[0]);
  const updates = cols.filter((c) => !key.includes(c))
    .map((c) => `"${c}" = excluded."${c}"`).join(", ");
  const conflict = `(${key.map((k) => `"${k}"`).join(",")})`;
  await sql`
    insert into ${sql(table)} ${sql(rows as any, cols)}
    on conflict ${sql.unsafe(conflict)}
    ${updates ? sql.unsafe(`do update set ${updates}`) : sql.unsafe("do nothing")}`;
}

/** Keep an untouched copy of everything received. */
export async function saveRaw(
  source: string,
  objectType: string,
  items: { id: string }[],
  via: "webhook" | "poll" | "backfill",
) {
  if (items.length === 0) return;
  const sql = db();
  const rows = items.map((it) => ({
    source, object_type: objectType, source_id: it.id,
    payload: sql.json(it as never), received_via: via,
  }));
  await sql`insert into raw.records ${sql(rows)}`;
}

/** Make sure a parent row exists so child rows never fail on a foreign key.
 *  Placeholders are filled in by the next fetch of that record. */
export async function ensurePlaceholders(table: "public.clients" | "public.properties" | "public.quotes" | "public.requests" | "public.jobs", ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return [];
  const sql = db();
  const name = table.split(".")[1];
  const defaults: Record<string, string> = {
    clients: "name", quotes: "created_at", requests: "created_at", jobs: "created_at", properties: "",
  };
  const extra = defaults[name];
  const inserted = await sql`
    insert into ${sql(table)} (id ${extra ? sql.unsafe(`, ${extra}`) : sql``})
    select x ${extra === "name" ? sql`, '(syncing)'` : extra ? sql`, now()` : sql``}
    from unnest(${unique}::text[]) as x
    on conflict (id) do nothing
    returning id`;
  return inserted.map((r) => r.id as string);
}
