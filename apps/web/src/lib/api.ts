export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api/v1";

interface ApiOptions extends RequestInit {
  retryAfterRefresh?: boolean;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { retryAfterRefresh = true, ...requestOptions } = options;
  const response = await fetch(`${API_URL}${path}`, {
    ...requestOptions,
    credentials: "include",
    headers: {
      ...(requestOptions.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...requestOptions.headers
    }
  });

  const canRefresh = path === "/auth/me" || !path.startsWith("/auth/");
  if (response.status === 401 && retryAfterRefresh && canRefresh) {
    const refresh = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include"
    });
    if (refresh.ok) {
      return apiRequest<T>(path, { ...options, retryAfterRefresh: false });
    }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; retryAfterSeconds?: number } | null;
    const headerRetryAfter = response.headers.get("Retry-After");
    const parsedRetryAfter = headerRetryAfter === null ? undefined : Number(headerRetryAfter);
    const retryAfterSeconds = parsedRetryAfter !== undefined && Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0
      ? Math.ceil(parsedRetryAfter)
      : body?.retryAfterSeconds;
    throw new ApiRequestError(
      body?.error ?? `Request failed (${response.status})`,
      response.status,
      retryAfterSeconds
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}
