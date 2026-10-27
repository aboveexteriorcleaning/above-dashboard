import { Shell, requireSession } from "@/components/Shell";
import { MyStats } from "@/components/MyStats";
import { resolvePeriod } from "@/lib/periods";

export const dynamic = "force-dynamic";

// Shows only the signed-in person's own numbers, plus company totals.
// No rankings and no other person's numbers: the database refuses to send them.
export default async function Me({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const session = await requireSession(["owner", "crew"]);
  const period = resolvePeriod((await searchParams).p);
  return (
    <Shell page="me" session={session}>
      <main>
        <MyStats period={period} first={session.name?.split(" ")[0]} base="/me" />
      </main>
    </Shell>
  );
}
