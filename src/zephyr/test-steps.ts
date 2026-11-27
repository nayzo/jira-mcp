import { OperationError, requestJson } from "../http.js";
import { issuePath, JiraClient, pathSegment } from "../jira/api.js";
import { generateZephyrJwt } from "./auth.js";

type Step = { step: string; data?: string; result?: string };
type StoredStep = Step & { id: number; orderId: number };

export async function getJiraTestIds(jira: JiraClient, ticketKey: string) {
  const operation = "resolve Jira test ticket IDs";
  const issue = await jira.get<{ id?: string; fields?: { project?: { id?: string } } }>(
    operation, issuePath(ticketKey), { fields: "project" },
  );
  const projectId = issue?.fields?.project?.id;
  if (!issue?.id || !projectId) throw new OperationError(`${operation}: issue ID or project ID is missing`, undefined, operation);
  return { issueId: issue.id, projectId };
}

function zephyr<T>(operation: string, method: "GET" | "POST", issueId: string, projectId: string, step?: Step) {
  const base = (process.env.ZAPI_BASE_URL || "https://prod-api.zephyr4jiracloud.com/connect").replace(/\/$/, "");
  const accessKey = process.env.ZAPI_ACCESS_KEY;
  if (!accessKey || !process.env.ZAPI_SECRET_KEY) {
    throw new OperationError(`${operation}: configure ZAPI_ACCESS_KEY and ZAPI_SECRET_KEY`, undefined, operation);
  }
  const path = `/public/rest/api/1.0/teststep/${pathSegment(issueId)}`;
  const params = { projectId };
  const token = generateZephyrJwt(method, path, params);
  return requestJson<T>(`${base}${path}?${new URLSearchParams(params)}`, operation, method, {
    zapiAccessKey: accessKey, Authorization: `JWT ${token}`,
  }, step && { projectId, ...step }, method === "GET");
}

export async function getZephyrTestSteps(issueId: string, projectId: string) {
  const operation = "get Zephyr test steps";
  const steps = await zephyr<StoredStep[]>(operation, "GET", issueId, projectId);
  if (!Array.isArray(steps)) throw new OperationError(`${operation}: unexpected response from Zephyr`, undefined, operation);
  return steps.map(({ id, orderId, step, data = "", result = "" }) => ({ id, orderId, step, data, result }));
}

export function addZephyrTestStep(issueId: string, projectId: string, { step, data = "", result = "" }: Step) {
  return zephyr<void>("add Zephyr test step", "POST", issueId, projectId, { step, data, result });
}
