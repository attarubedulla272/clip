export function shouldSkipApiRateLimit(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
