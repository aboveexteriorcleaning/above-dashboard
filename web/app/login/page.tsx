import { SubmitButton } from "@/components/SubmitButton";
import { sendLoginLink, demoSignIn } from "./actions";
import { isDemo } from "@/lib/supabase";

export default async function Login({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="login">
      <div className="login-box stack">
        <h1>Above</h1>
        <p className="muted">Team and business numbers for Above Exterior Cleaning.</p>

        {isDemo() ? (
          <form action={demoSignIn} className="stack">
            <p className="notice">Preview mode with sample data. Pick a view:</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" name="role" value="owner">View as owner</button>
              <button className="btn quiet" name="role" value="crew">View as crew</button>
            </div>
          </form>
        ) : sp.sent ? (
          <p className="notice">Check your email for a sign-in link. It works once and expires in an hour.</p>
        ) : (
          <form action={sendLoginLink} className="stack">
            <div>
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <SubmitButton pending="Sending…">Email me a sign-in link</SubmitButton>
            {sp.error && <p className="notice warn">{sp.error}</p>}
            <p className="muted small">Only people an owner has added can sign in.</p>
          </form>
        )}
      </div>
    </main>
  );
}
