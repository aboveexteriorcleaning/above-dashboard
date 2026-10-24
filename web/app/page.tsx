import { redirect } from "next/navigation";
import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!s.linked || !s.role) redirect("/not-set-up");
  redirect(s.role === "owner" ? "/overview" : "/me");
}
