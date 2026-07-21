// The ping receiver — the other end of src/ping/transport.ts. The client
// POSTs {version, install_id} weekly per consenting install and ignores the
// response entirely (fire-and-forget, 2s ceiling), so this Worker's only
// jobs are: accept the pinned shape, count it, and store NOTHING else. The
// privacy law is load-bearing here exactly as in the client: an install id
// and a version string are the entire recorded surface — no IP, no
// user-agent, no timestamps beyond what the analytics dataset stamps on the
// datapoint itself.

// One datapoint per accepted ping: index = install_id (distinct-install
// queries sample correctly), blob = version, double = 1 (count).
const MAX_BODY_BYTES = 1024;
const ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;
const VERSION_MAX = 64;

function bare(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ping") {
      return bare(404);
    }
    if (request.method !== "POST") {
      return bare(405, { allow: "POST" });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      return bare(413);
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return bare(413);
    }

    let payload: { version?: unknown; install_id?: unknown };
    try {
      payload = JSON.parse(raw) as { version?: unknown; install_id?: unknown };
    } catch {
      return bare(400);
    }
    const { version, install_id } = payload;
    if (typeof install_id !== "string" || !ID_SHAPE.test(install_id)) {
      return bare(400);
    }
    if (typeof version !== "string" || version.length === 0 || version.length > VERSION_MAX) {
      return bare(400);
    }

    // writeDataPoint is synchronous and buffered by the runtime — nothing to
    // await, nothing to waitUntil.
    env.PINGS.writeDataPoint({
      indexes: [install_id],
      blobs: [version],
      doubles: [1],
    });
    return bare(204);
  },
} satisfies ExportedHandler<Env>;
