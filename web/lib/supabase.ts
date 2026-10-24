import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Acts as the signed-in person. Every query is filtered by the database's access rules. */
export async function supabaseForUser() {
  const store = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only in pages */ }
      },
    },
  });
}

/** Admin client: ONLY for sending login invites, and only after the caller is verified as an owner.
 *  Never used to read business data. Server-side only. */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const isDemo = () => process.env.DEMO_MODE === "1";
