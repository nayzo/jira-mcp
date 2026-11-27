type Method = "GET" | "POST" | "PUT" | "DELETE";
type WriteFailure = "rejected" | "uncertain";

export class OperationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly operation?: string,
    readonly errorMessages: string[] = [],
    readonly errors: Record<string, string> = {},
    readonly writeFailure?: WriteFailure,
  ) {
    super(message);
  }
}

type ErrorDetails = { error: string; status?: number; operation?: string; errorMessages?: string[]; errors?: Record<string, string> };

export function safeError(error: unknown): ErrorDetails {
  if (!(error instanceof OperationError)) return { error: "Unexpected internal error" };
  return {
    error: error.message,
    status: error.status,
    operation: error.operation,
    ...(error.errorMessages.length ? { errorMessages: error.errorMessages } : {}),
    ...(Object.keys(error.errors).length ? { errors: error.errors } : {}),
  };
}

function redact(text: string, secrets: string[]): string {
  const values = [...secrets, ...[
    "JIRA_USERNAME", "JIRA_API_TOKEN", "ZAPI_ACCESS_KEY", "ZAPI_SECRET_KEY", "ZEPHYR_API_TOKEN",
  ].map((key) => process.env[key])].filter((value): value is string => Boolean(value));
  const basic = Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`).toString("base64");
  const variants = [basic, ...values.flatMap((value) => [value, encodeURIComponent(value)])];
  for (const value of variants.sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(value, "[REDACTED]");
  }
  return text
    .replace(/\b(Basic|Bearer|JWT)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 500);
}

function retryDelay(header: string | null): number {
  if (header === null) return 2_000;
  if (/^\d+$/.test(header)) return Number(header) * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 2_000;
}

export async function requestJson<T>(
  url: string,
  operation: string,
  method: Method,
  headers: Record<string, string>,
  body?: unknown,
  expectJson = true,
): Promise<T> {
  const isWrite = method !== "GET";
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  const send = () => fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
    body: encodedBody,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  let response: Response;
  try {
    response = await send();
    const delay = retryDelay(response.headers.get("Retry-After"));
    if (method === "GET" && response.status === 429 && delay <= 10_000) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      response = await send();
    }
  } catch {
    throw new OperationError(
      `${operation}: request failed${isWrite ? "; verify whether the write succeeded before retrying" : ""}`,
      undefined, operation, [], {}, isWrite ? "uncertain" : undefined,
    );
  }

  if (response.ok && !expectJson) {
    await response.body?.cancel().catch(() => undefined);
    return undefined as T;
  }
  const data: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    if (data !== undefined) return data as T;
    throw new OperationError(
      `${operation}: invalid JSON from server${isWrite ? "; verify whether the write succeeded before retrying" : ""}`,
      response.status, operation, [], {}, isWrite ? "uncertain" : undefined,
    );
  }

  const details = data as { errorMessages?: unknown; errors?: unknown } | undefined;
  const sanitize = (text: string) => redact(text, Object.values(headers));
  const errorMessages = Array.isArray(details?.errorMessages)
    ? details.errorMessages.filter((value): value is string => typeof value === "string").slice(0, 10).map(sanitize)
    : [];
  const errors = Object.fromEntries(details?.errors && typeof details.errors === "object" && !Array.isArray(details.errors)
    ? Object.entries(details.errors).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .slice(0, 20).map(([key, value]) => [sanitize(key), sanitize(value)])
    : []);
  const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
  throw new OperationError(`${operation}: HTTP ${response.status}`, response.status, operation, errorMessages, errors,
    isWrite ? (refused ? "rejected" : "uncertain") : undefined);
}
