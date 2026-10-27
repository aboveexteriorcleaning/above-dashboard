// Runs before every page: refreshes the login session and sends signed-out
// visitors to the login page. Data access is still enforced by the database.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PUBLIC = ["/login", "/auth/callback"];

export async function proxy(req: NextRequest) {
  if (process.env.DEMO_MODE === "1") {
    if (!PUBLIC.some((p) => req.nextUrl.pathname.startsWith(p)) && !req.cookies.get("demo_role")) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  }

  let res = NextResponse.next({ request: req });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user && !PUBLIC.some((p) => req.nextUrl.pathname.startsWith(p))) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|logo-light.png|logo-dark.png).*)"] };
