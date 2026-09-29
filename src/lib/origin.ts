export function checkOrigin(headers: Headers, requestProtocol: string): void {
  const origin = headers.get("origin");
  if (!origin) return;

  const host = headers.get("host");
  try {
    const parsed = new URL(origin);
    const protocol = `${(headers.get("x-forwarded-proto") || requestProtocol).replace(/:$/, "")}:`;
    if (host && parsed.host.toLowerCase() === host.toLowerCase() && parsed.protocol === protocol) return;
  } catch {
    // Malformed Origin headers are rejected below.
  }
  throw new Error("跨来源请求被拒绝");
}
