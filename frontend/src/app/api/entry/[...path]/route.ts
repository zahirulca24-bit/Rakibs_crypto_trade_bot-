const BACKEND_API_BASE_URL =
  process.env.BACKEND_API_BASE_URL ?? "https://rakibs-crypto-market-api.onrender.com";

async function proxy(request: Request, path: string[]) {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/api/entry/${path.join("/")}`, BACKEND_API_BASE_URL);
  targetUrl.search = incomingUrl.search;

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
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
    return Response.json({ detail: "Entry Engine backend is unavailable" }, { status: 502 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}
