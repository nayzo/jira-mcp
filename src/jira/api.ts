import { OperationError, requestJson } from "../http.js";

type Query = Record<string, string | number | undefined>;

export type JiraPage<T> = { values: T[]; startAt?: number; total?: number; isLast?: boolean };

export async function allPages<T>(operation: string, fetchPage: (startAt: number) => Promise<JiraPage<T>>): Promise<T[]> {
  const values: T[] = [];
  let startAt = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await fetchPage(startAt);
    if (!Array.isArray(page?.values)) break;
    values.push(...page.values);
    const next = (page.startAt ?? startAt) + page.values.length;
    if (page.isLast === true || (page.total !== undefined && next >= page.total)) return values;
    if (!page.values.length && page.isLast === undefined && page.total === undefined) return values;
    if (!page.values.length || next <= startAt) break;
    startAt = next;
  }
  throw new OperationError(`${operation}: could not read all pages`, undefined, operation);
}

export function pathSegment(value: string) {
  if (!value || value === "." || value === "..") throw new OperationError("Invalid Jira identifier");
  return encodeURIComponent(value);
}

export const issuePath = (key: string) => `/rest/api/3/issue/${pathSegment(key)}`;

export class JiraClient {
  private readonly host = process.env.JIRA_HOST?.trim();
  private readonly username = process.env.JIRA_USERNAME;
  private readonly token = process.env.JIRA_API_TOKEN;

  private request<T>(operation: string, path: string, method: "GET" | "POST" | "PUT" | "DELETE", query?: Query, body?: unknown, expectJson = true): Promise<T> {
    if (!this.host || !/^[\w.-]+(?::\d+)?$/.test(this.host) || !this.username || !this.token) {
      throw new OperationError(`${operation}: configure JIRA_HOST, JIRA_USERNAME and JIRA_API_TOKEN`, undefined, operation);
    }
    const url = new URL(`https://${this.host}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const auth = Buffer.from(`${this.username}:${this.token}`).toString("base64");
    return requestJson<T>(url.href, operation, method, { Authorization: `Basic ${auth}` }, body, expectJson);
  }

  get<T>(operation: string, path: string, query?: Query) {
    return this.request<T>(operation, path, "GET", query);
  }

  post<T>(operation: string, path: string, body: unknown) {
    return this.request<T>(operation, path, "POST", undefined, body);
  }

  command(operation: string, path: string, body: unknown) {
    return this.request<void>(operation, path, "POST", undefined, body, false);
  }

  put(operation: string, path: string, body: unknown) {
    return this.request<void>(operation, path, "PUT", undefined, body, false);
  }

  delete(operation: string, path: string) {
    return this.request<void>(operation, path, "DELETE", undefined, undefined, false);
  }
}
