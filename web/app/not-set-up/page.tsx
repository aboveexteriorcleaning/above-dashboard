import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NotSetUp() {
  const s = await getSession();
  return (
    <main className="login">
      <div className="login-box stack">
        <h1>Almost there</h1>
        <p>
          You&rsquo;re signed in{ s?.email ? <> as <strong>{s.email}</strong></> : null }, but this email isn&rsquo;t linked
          to anyone on the team yet.
        </p>
        <p className="muted">Ask Kale or Grady to add this email to your profile on the Team page, then sign in again.</p>
        <form action="/auth/signout" method="post"><button className="btn quiet">Sign out</button></form>
      </div>
    </main>
  );
}
