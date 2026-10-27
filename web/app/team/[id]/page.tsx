import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell, requireSession } from "@/components/Shell";
import { MyStats } from "@/components/MyStats";
import { getTeam } from "@/lib/data";
import { resolvePeriod } from "@/lib/periods";

export const dynamic = "force-dynamic";

// Owners only: a team member's "My stats" page, exactly as they see it when they sign in.
export default async function Person({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner"]);
  const { id } = await params;
  const period = resolvePeriod((await searchParams).p);
  const person = (await getTeam()).find((m) => m.id === id);
  if (!person) notFound();
  const first = person.full_name.split(" ")[0];
  return (
    <Shell page="team" session={session}>
      <main>
        <p className="notice viewas">
          <Link href={`/team?p=${period.key}`}>&larr; Team</Link>
          <span>You&rsquo;re seeing {first}&rsquo;s page exactly as {first} sees it when they sign in.</span>
        </p>
        <MyStats period={period} first={first} base={`/team/${person.id}`} viewAs={person.id} />
      </main>
    </Shell>
  );
}
