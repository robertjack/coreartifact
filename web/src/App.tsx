import { useEffect, useState } from "react";

// Shell only (plan-gate repair, 2026-07-17): this file owns the dashboard
// chrome and a tiny client-side router with exactly two routes — the
// overview ("/") and the session view ("/session/:id"). It must NEVER
// import web/src/views/** — each UI issue owns its own view file and wires
// its own route here (a `touches` in THEIR footprint, authorized by their
// dependency on this issue). Until then, every route renders the same
// inline not-yet-wired placeholder so this builds green on its own.

function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return pathname;
}

function NotYetWired({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
      {label} — not yet wired.
    </div>
  );
}

function matchRoute(pathname: string): { route: "overview" | "session" | "unknown"; sessionId?: string } {
  if (pathname === "/") return { route: "overview" };
  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) return { route: "session", sessionId: sessionMatch[1] };
  return { route: "unknown" };
}

export default function App() {
  const pathname = usePathname();
  const matched = matchRoute(pathname);

  let content: React.ReactNode;
  switch (matched.route) {
    case "overview":
      content = <NotYetWired label="Overview" />;
      break;
    case "session":
      content = <NotYetWired label={`Session view (${matched.sessionId})`} />;
      break;
    default:
      content = <NotYetWired label="This route" />;
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
          <span className="h-2.5 w-2.5 rounded-sm bg-zinc-900" />
          coreartifact
        </div>
      </header>
      <main className="p-6">{content}</main>
    </div>
  );
}
