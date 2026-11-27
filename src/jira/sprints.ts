import { OperationError } from "../http.js";
import { allPages, JiraClient } from "./api.js";

export type SprintState = "active" | "future" | "closed";
type Sprint = { id: number; name: string; state: SprintState; startDate?: string; endDate?: string; goal?: string };

export async function getSprints(jira: JiraClient, board: number, state?: SprintState) {
  const operation = "list board sprints";
  const values = await allPages<Sprint>(operation, (startAt) => jira.get(
    operation, `/rest/agile/1.0/board/${board}/sprint`, { state, startAt, maxResults: 50 },
  ));
  return values.map(({ id, name, state, startDate, endDate, goal }) => ({ id, name, state, startDate, endDate, goal }));
}

export async function resolveSprint(jira: JiraClient, id: number | undefined, name: string | undefined) {
  if (name === undefined) return id;
  if (id !== undefined) throw new OperationError("Provide sprint_id or sprint, not both");
  if (!name.trim()) throw new OperationError("sprint must not be blank");
  const board = Number(process.env.JIRA_SPRINT_BOARD_ID);
  if (!Number.isSafeInteger(board) || board <= 0) {
    throw new OperationError("Configure JIRA_SPRINT_BOARD_ID to use a sprint name, or provide sprint_id");
  }
  const matches = (await getSprints(jira, board)).filter((sprint) => sprint.name.toLowerCase() === name.trim().toLowerCase());
  if (matches.length !== 1) {
    throw new OperationError(`Sprint name ${matches.length ? "is ambiguous" : "was not found"} on the configured board; use get-sprints and provide sprint_id`);
  }
  if (matches[0].state === "closed") throw new OperationError("Cannot move a ticket to a closed sprint; provide an active or future sprint_id");
  return matches[0].id;
}

export async function moveToSprint(jira: JiraClient, ticketKey: string, sprintId: number) {
  await jira.command("move ticket to sprint", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: [ticketKey] });
  return { ticket_key: ticketKey, sprint_id: sprintId, moved: true };
}
