const BACKEND_API_BASE_URL =
  process.env.BACKEND_API_BASE_URL ?? "https://rakibs-crypto-market-api.onrender.com";

async function proxy(request: Request, path: string[], method: "GET" | "POST") {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/api/strategy/${path.join("/")}`, BACKEND_API_BASE_URL);
  targetUrl.search = incomingUrl.search;

  try {
    const body = method === "POST" ? await request.text() : undefined;
    const response = await fetch(targetUrl, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body,
    });
    const responseBody = await response.text();
    return new Response(responseBody, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ detail: "Strategy Engine backend is unavailable" }, { status: 502 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(request, path, "GET");
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(request, path, "POST");
}
