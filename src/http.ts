import fetch from "node-fetch";
import type { RequestInit, Response } from "node-fetch";

export const TIMEOUT_MS = 30_000;

export async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  const makeRequest = () => fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) as any });
  const response = await makeRequest();
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 10_000) : 2_000;
    if (process.env.DEBUG === "true") {
      console.error(`[JIRA-MCP] Rate limited (429), retrying after ${waitMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return makeRequest();
  }
  return response;
}
