import { OperationError, safeError } from "../http.js";
import { issuePath, JiraClient } from "./api.js";
import { JiraFields } from "./fields.js";
import { adfToMarkdown } from "./formatting.js";

type Fields = Record<string, unknown>;
type Issue = { key: string; fields: Fields };
type Person = { accountId?: string; displayName?: string };
type Page = { startAt?: number; maxResults?: number; total?: number };
type Comment = { id: string; author?: Person; created?: string; updated?: string; body?: unknown };
type Worklog = { id: string; author?: Person; started?: string; timeSpentSeconds?: number; timeSpent?: string; comment?: unknown };

const compactFields = "summary,issuetype,status,priority,assignee,reporter,parent,labels,created,updated,duedate,resolutiondate,description,timespent";
export const searchFields = "summary,issuetype,status,priority,assignee,parent,updated,description";
const preview = (value: unknown) => {
  if (value === null || value === undefined) return value;
  const markdown = adfToMarkdown(value);
  return markdown.length > 1_000 ? `${markdown.slice(0, 1_000)}…` : markdown;
};

function person(value: Person | null | undefined) {
  return value == null ? value : { accountId: value.accountId, displayName: value.displayName };
}

function projectField(field: string, value: unknown): unknown {
  if (value == null) return value;
  switch (field) {
    case "description": return adfToMarkdown(value);
    case "status":
    case "priority":
    case "issuetype": return (value as { name?: string })?.name ?? value;
    case "assignee":
    case "reporter": return person(value as Person);
    case "parent": {
      const { key, fields } = value as Issue;
      return { key, summary: fields?.summary };
    }
    default: return value;
  }
}

function projectFields(fields: Fields, select: (field: string) => boolean) {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => select(key)).map(([key, value]) => [key, projectField(key, value)]));
}

function sprintSummary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sprintSummary);
  if (!value || typeof value !== "object") return value;
  const { id, name, state, startDate, endDate } = value as Fields;
  return { id, name, state, startDate, endDate };
}

export async function getTicket(jira: JiraClient, fields: JiraFields, key: string, raw?: boolean) {
  const path = issuePath(key);
  const getIssue = (fields?: string) => jira.get<Issue>("get ticket", path, { fields });
  if (raw) {
    const issue = await getIssue();
    if (!issue?.fields) throw new OperationError("get ticket: no fields returned by Jira");
    return `JIRA Ticket: ${key}, Fields: ${JSON.stringify(issue.fields, null, 2)}`;
  }

  const warnings: Partial<Record<"sprint" | "comments" | "worklogs", ReturnType<typeof safeError>>> = {};
  let sprint: string | undefined;
  try {
    sprint = await fields.sprintField();
    if (!sprint) throw new OperationError("Sprint field was not found; configure JIRA_SPRINT_FIELD if the tenant uses a different name");
  } catch (error) {
    warnings.sprint = safeError(error);
  }
  const issue = await getIssue(sprint ? `${compactFields},${sprint}` : compactFields).catch((error) => {
    if (!sprint || !(error instanceof OperationError) || (error.status !== 400 && error.status !== 403)) throw error;
    warnings.sprint = safeError(error);
    sprint = undefined;
    return getIssue(compactFields);
  });
  if (!issue?.fields) throw new OperationError("get ticket: no fields returned by Jira");
  if (sprint && !Object.hasOwn(issue.fields, sprint)) warnings.sprint = { error: "Jira did not return the Sprint field", operation: "get ticket" };

  async function optional<T>(section: "comments" | "worklogs", read: () => Promise<T>) {
    try {
      return await read();
    } catch (error) {
      warnings[section] = safeError(error);
    }
  }
  const [comments, total] = await Promise.all([
    optional("comments", async () => {
      const page = await jira.get<{ comments: Comment[] }>("get recent comments", `${path}/comment`, { orderBy: "-created", maxResults: 5 });
      if (!Array.isArray(page?.comments)) throw new OperationError("Jira did not return a comments page");
      return page.comments.slice(0, 5).map(({ id, author, created, updated, body }) => ({
        id, author: person(author), created, updated, body: preview(body),
      }));
    }),
    optional("worklogs", async () => {
      const page = await jira.get<Page>("get worklog summary", `${path}/worklog`, { startAt: 0, maxResults: 1 });
      const total = page?.total;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new OperationError("Jira did not return a worklog count");
      return total;
    }),
  ]);

  const { timespent } = issue.fields;
  const visible = new Set(compactFields.split(",").filter((field) => field !== "timespent"));
  return {
    ...projectFields(issue.fields, (field) => visible.has(field)),
    key: issue.key ?? key,
    sprint: sprint ? sprintSummary(issue.fields[sprint]) : undefined,
    comments,
    worklogs: total !== undefined || timespent !== undefined ? { total, timeSpentSeconds: timespent } : undefined,
    warnings: Object.keys(warnings).length ? warnings : undefined,
  };
}

export async function searchTickets(jira: JiraClient, jql: string, maxResults: number, fields: string, cursor?: string) {
  const requested = fields.split(",").map((field) => field.trim()).filter(Boolean);
  const include = new Set(requested.filter((field) => !field.startsWith("-")));
  const exclude = new Set(requested.filter((field) => field.startsWith("-")).map((field) => field.slice(1)));
  const all = include.has("*all") || include.has("*navigable") || (include.size === 0 && exclude.size > 0);
  const page = await jira.get<{ issues: Issue[]; nextPageToken?: string; isLast?: boolean }>("search Jira tickets", "/rest/api/3/search/jql", {
    jql, maxResults, fields: requested.join(","), nextPageToken: cursor,
  });
  if (!Array.isArray(page?.issues)) throw new OperationError("search Jira tickets: no issue page returned by Jira");
  const tickets = page.issues.map((issue) => ({
    ...projectFields(issue.fields ?? {}, (key) => (all || include.has(key)) && !exclude.has(key)), key: issue.key,
  }));
  return { tickets, count: tickets.length, next_page_token: page.nextPageToken, is_last: page.isLast };
}

export async function listWorklogs(jira: JiraClient, key: string, startAt: number, maxResults: number) {
  const page = await jira.get<Page & { worklogs: Worklog[] }>("list ticket worklogs", `${issuePath(key)}/worklog`, { startAt, maxResults });
  if (!Array.isArray(page?.worklogs)) throw new OperationError("list ticket worklogs: no page returned by Jira");
  const offset = page.startAt ?? startAt;
  const next = offset + page.worklogs.length;
  return {
    ticket_key: key,
    start_at: offset,
    max_results: page.maxResults ?? maxResults,
    total: page.total,
    next_start_at: page.worklogs.length && page.total !== undefined && next < page.total ? next : undefined,
    worklogs: page.worklogs.map(({ id, author, started, timeSpentSeconds, timeSpent, comment }) => ({
      id, author: person(author), started, timeSpentSeconds, timeSpent, comment: preview(comment),
    })),
  };
}
