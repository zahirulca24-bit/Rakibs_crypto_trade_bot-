const BACKEND_API_BASE_URL =
  process.env.BACKEND_API_BASE_URL ?? "https://rakibs-crypto-market-api.onrender.com";

async function proxy(request: Request, path: string[], method: "GET" | "POST") {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/api/indicators/${path.join("/")}`, BACKEND_API_BASE_URL);
  targetUrl.search = incomingUrl.search;

  try {
    const response = await fetch(targetUrl, {
      method,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("Indicator Engine proxy error", error);
    return Response.json(
      { detail: "Indicator Engine backend is unavailable. Please retry after the service wakes up." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path, "GET");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path, "POST");
}
