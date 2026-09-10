const BACKEND_API_BASE_URL = process.env.BACKEND_API_BASE_URL ?? "http://localhost:8000";

async function proxy(request: Request, path: string[], method: "GET" | "POST") {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/api/indicators/${path.join("/")}`, BACKEND_API_BASE_URL);
  targetUrl.search = incomingUrl.search;

  try {
    const response = await fetch(targetUrl, { method, cache: "no-store" });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ detail: "Indicator Engine service is unavailable" }, { status: 502 });
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
