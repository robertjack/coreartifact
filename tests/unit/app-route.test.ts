import { describe, it, expect } from "vitest";
import { matchRoute } from "../../web/src/App";
import { sessionRow } from "../../web/src/views/overview/model";

describe("App route matching — session href round trip (F184)", () => {
  it("recovers the exact session id matchRoute extracts from a percent-encoded path segment", () => {
    const sessionId = "abc def/123";
    const matched = matchRoute(`/session/${encodeURIComponent(sessionId)}`);
    expect(matched.route).toBe("session");
    expect(matched.sessionId).toBe(sessionId);
  });

  it("round-trips a session id containing a percent-encodable character through sessionRow's href and App's matchRoute", () => {
    const sessionId = "sess id/with special?chars#42";
    const row = sessionRow({
      session_id: sessionId,
      repo_root: "/some/repo",
      classification: null,
    });

    // The href is `/session/<id>?repo=<repo>` — strip the query string the
    // way a browser Link click would, leaving only the pathname App reads.
    const pathname = row.href.split("?")[0];
    const matched = matchRoute(pathname);

    expect(matched.route).toBe("session");
    expect(matched.sessionId).toBe(sessionId);
  });
});
