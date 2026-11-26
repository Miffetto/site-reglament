const siteOrigin = "https://miffetto.github.io";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const responseHeaders = {
  "Access-Control-Allow-Origin": siteOrigin,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};

type BracketRequest = {
  p_action: "read" | "login" | "winner" | "logout";
  p_code?: string;
  p_token?: string;
  p_match_id?: number;
  p_team_id?: number;
  p_revision?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

async function bracketRequest(payload: BracketRequest): Promise<Response> {
  if (!supabaseUrl || !serviceRole) return json({ error: "unavailable" }, 503);

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/lucky_league_bracket`, {
      method: "POST",
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const result: unknown = await response.json();
      if (isRecord(result) && isIntegerInRange(result.status, 200, 599) && isRecord(result.body)) {
        return json(result.body, result.status);
      }
    }
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  return json({ error: "unavailable" }, 503);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");
  if (origin && origin !== siteOrigin) return json({ error: "forbidden_origin" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
  if (request.method === "GET") return bracketRequest({ p_action: "read" });
  if (request.method !== "POST") return json({ error: "invalid_request" }, 405);
  if (Number(request.headers.get("Content-Length")) > 1024) return json({ error: "invalid_request" }, 413);
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim();
  if (contentType !== "text/plain" && contentType !== "application/json") {
    return json({ error: "invalid_request" }, 415);
  }

  let payload: unknown;
  try {
    const body = await request.text();
    if (body.length > 1024) return json({ error: "invalid_request" }, 413);
    payload = JSON.parse(body);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!isRecord(payload)) return json({ error: "invalid_request" }, 400);
  if (payload.action === "login") {
    if (typeof payload.code !== "string" || !/^[0-9]{5}$/.test(payload.code)) {
      return json({ error: "invalid_request" }, 400);
    }
    return bracketRequest({ p_action: "login", p_code: payload.code });
  }

  const token = contentType === "text/plain"
    ? payload.session
    : request.headers.get("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    return json({ error: "session_expired" }, 401);
  }
  if (payload.action === "logout") return bracketRequest({ p_action: "logout", p_token: token });
  if (payload.action !== "winner" || !isIntegerInRange(payload.matchId, 1, 15) ||
    !isIntegerInRange(payload.teamId, 1, 16) || !isIntegerInRange(payload.revision, 0, 2147483647)) {
    return json({ error: "invalid_request" }, 400);
  }
  return bracketRequest({
    p_action: "winner",
    p_token: token,
    p_match_id: payload.matchId,
    p_team_id: payload.teamId,
    p_revision: payload.revision,
  });
});
