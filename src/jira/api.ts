import fetch from "node-fetch";
import {
  JiraCreateResponse,
  JiraSearchResponse,
  JiraCommentResponse,
  JiraCommentsListResponse,
  JiraTransitionsResponse,
  JiraChangelogResponse,
  JiraWorklogEntry,
  JiraSprintListResponse,
  JiraDevInfoResponse,
} from "./types.js";

function buildUrl(path: string): string {
  return `https://${process.env.JIRA_HOST}${path}`;
}

function parseError(data: any, status: number, statusText: string): string {
  if (data?.errorMessages?.length) {
    return data.errorMessages.join(", ");
  }

  if (data?.errors && Object.keys(data.errors).length > 0) {
    const fieldLabels: Record<string, string> = {
      [process.env.JIRA_STORY_POINTS_FIELD ?? ""]: `story_points (${process.env.JIRA_STORY_POINTS_FIELD ?? "JIRA_STORY_POINTS_FIELD"})`,
      [process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD ?? ""]: `acceptance_criteria (${process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD ?? "JIRA_ACCEPTANCE_CRITERIA_FIELD"})`,
      [process.env.JIRA_EPIC_LINK_FIELD ?? ""]: `parent_epic (${process.env.JIRA_EPIC_LINK_FIELD ?? "JIRA_EPIC_LINK_FIELD"})`,
      customfield_10020: "sprint (customfield_10020)",
      customfield_10596: "story_readiness (customfield_10596)",
    };

    const messages = Object.entries(data.errors as Record<string, string>).map(
      ([field, msg]) => {
        const label = fieldLabels[field] ?? field;
        return `${label}: ${msg}`;
      }
    );

    return messages.join("; ");
  }

  return `HTTP ${status} ${statusText}`;
}

export async function createJiraTicket(
  payload: any,
  auth: string
): Promise<{ success: boolean; data: JiraCreateResponse; errorMessage?: string }> {
  const url = buildUrl("/rest/api/3/issue");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as JiraCreateResponse;

    if (!response.ok) {
      return { success: false, data, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function updateJiraTicket(
  ticketKey: string,
  payload: any,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}`);

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function createTicketLink(
  outwardIssue: string,
  inwardIssue: string,
  linkType: string,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl("/rest/api/3/issueLink");

  const payload = {
    outwardIssue: { key: outwardIssue },
    inwardIssue: { key: inwardIssue },
    type: { name: linkType },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
    });

    if (response.status === 201 || response.status === 200) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function searchJiraTickets(
  jql: string,
  maxResults: number,
  auth: string
): Promise<{ success: boolean; data: JiraSearchResponse; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraSearchResponse;

    if (!response.ok) {
      return { success: false, data, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addJiraComment(
  ticketKey: string,
  body: any,
  auth: string
): Promise<{ success: boolean; data?: JiraCommentResponse; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/comment`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ body }),
    });

    if (response.status === 201) {
      const data = (await response.json()) as JiraCommentResponse;
      return { success: true, data };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraComments(
  ticketKey: string,
  maxResults: number,
  auth: string
): Promise<{ success: boolean; data?: JiraCommentsListResponse; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/comment?maxResults=${maxResults}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraCommentsListResponse;

    if (!response.ok) {
      return { success: false, data, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraTransitions(
  ticketKey: string,
  auth: string
): Promise<{ success: boolean; data?: JiraTransitionsResponse; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/transitions`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraTransitionsResponse;

    if (!response.ok) {
      return { success: false, data, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function transitionJiraTicket(
  ticketKey: string,
  transitionId: string,
  comment: any | undefined,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/transitions`);

  const payload: any = { transition: { id: transitionId } };
  if (comment) {
    payload.update = { comment: [{ add: { body: comment } }] };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function assignJiraTicket(
  ticketKey: string,
  accountId: string | null,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/assignee`);

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ accountId }),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function addJiraWatcher(
  ticketKey: string,
  accountId: string,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/watchers`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(accountId),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeJiraWatcher(
  ticketKey: string,
  accountId: string,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/watchers?accountId=${encodeURIComponent(accountId)}`);

  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    if (response.status === 204) {
      return { success: true };
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch (_) {}

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraIssueHistory(
  ticketKey: string,
  auth: string
): Promise<{ success: boolean; data?: JiraChangelogResponse; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/changelog`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraChangelogResponse;

    if (!response.ok) {
      return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function addJiraWorklog(
  ticketKey: string,
  timeSpent: string,
  commentBody: any | undefined,
  auth: string
): Promise<{ success: boolean; data?: JiraWorklogEntry; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}/worklog`);
  const payload: any = { timeSpent };
  if (commentBody) payload.comment = commentBody;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as any;

    if (response.status === 201) {
      return { success: true, data };
    }

    return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraRelatedIssues(
  ticketKey: string,
  auth: string
): Promise<{ success: boolean; data?: any[]; errorMessage?: string }> {
  const url = buildUrl(`/rest/api/3/issue/${ticketKey}?fields=issuelinks`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as any;

    if (!response.ok) {
      return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data: data.fields?.issuelinks ?? [] };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraDevInfo(
  issueId: string,
  auth: string
): Promise<{ success: boolean; data?: JiraDevInfoResponse; errorMessage?: string }> {
  const url = buildUrl(
    `/rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=GitHub&dataType=pullrequest`
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraDevInfoResponse;

    if (!response.ok) {
      return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export async function getJiraBoardSprints(
  boardId: number,
  state: "active" | "future" | "closed" | undefined,
  auth: string
): Promise<{ success: boolean; data?: JiraSprintListResponse; errorMessage?: string }> {
  const stateParam = state ? `?state=${state}` : "";
  const url = buildUrl(`/rest/agile/1.0/board/${boardId}/sprint${stateParam}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    });

    const data = (await response.json()) as JiraSprintListResponse;

    if (!response.ok) {
      return { success: false, errorMessage: parseError(data, response.status, response.statusText) };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
