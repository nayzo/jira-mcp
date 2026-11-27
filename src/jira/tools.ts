import { STATUS_CODES } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OperationError } from "../http.js";
import { errorDetails, skipStep, stepReport, writeStep } from "../write-steps.js";
import { addZephyrTestStep, getJiraTestIds, getZephyrTestSteps } from "../zephyr/test-steps.js";
import { issuePath, JiraClient, pathSegment } from "./api.js";
import { FieldClaims, JiraFields } from "./fields.js";
import { formatDescription, formatJiraContent } from "./formatting.js";
import { getTicket, listWorklogs, searchFields, searchTickets } from "./reads.js";
import { getSprints, moveToSprint, resolveSprint } from "./sprints.js";
import { createIssue, getMyself, linkIssues, resolveAssignee, setLegacyDefaults, type IssueFields } from "./writes.js";

const ticket_key = z.string().min(1, "Ticket key is required");
const issue_type = z.enum(["Bug", "Task", "Story", "Test", "Epic"]);
const sprint_id = z.number().int().positive().safe().optional();
const choices = z.enum(["Yes", "No"]).optional();
const searchPage = {
  max_results: z.number().min(1).max(50).default(10).optional(),
  next_page_token: z.string().min(1).optional(),
};

function result(value: string | object, isError = false): CallToolResult {
  return {
    ...(isError && { isError }),
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function moveStep(jira: JiraClient, key: string, sprint: number) {
  return writeStep("move ticket to sprint", {
    rejected: "Correct the Jira Agile error, then call move-ticket-to-sprint with the ticket_key and sprint_id.",
    uncertain: "Check the ticket's current sprint in Jira (get-ticket) before retrying. If it has not moved, call move-ticket-to-sprint only.",
    not_attempted: "Correct the error, then call move-ticket-to-sprint with the ticket_key and sprint_id.",
  }, () => moveToSprint(jira, key, sprint));
}

async function runTool(name: string, handler: () => Promise<CallToolResult>) {
  try {
    return await handler();
  } catch (error) {
    return result(errorDetails(error, name), true);
  }
}

export function registerTools(server: McpServer, jira: JiraClient) {
  const fields = new JiraFields(jira);
  const project = () => process.env.JIRA_PROJECT_KEY || "SCRUM";

  function tool<S extends z.ZodRawShape>(
    name: string, description: string, shape: S,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<CallToolResult>,
  ) {
    server.tool<z.ZodRawShape>(name, description, shape, (args) =>
      runTool(name, () => handler(args as z.objectOutputType<S, z.ZodTypeAny>)));
  }

  tool("create-ticket", "Create a Jira ticket", {
    summary: z.string().min(1, "Summary is required"),
    issue_type: issue_type.default("Task"),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    story_points: z.number().optional(),
    create_test_ticket: z.boolean().optional(),
    parent_epic: z.string().optional(),
    sprint: z.string().optional(),
    sprint_id,
    story_readiness: choices,
    project_key: z.string().optional(),
    crisis: choices,
    assignee: z.string().optional().describe("Atlassian account ID, me, or unassigned"),
  }, async (args) => {
    const { summary, issue_type, description, parent_epic, story_points } = args;
    const projectKey = args.project_key || project();
    const wantsSprint = args.sprint_id !== undefined || args.sprint !== undefined;
    const wantsTest = (args.create_test_ticket ?? process.env.AUTO_CREATE_TEST_TICKETS !== "false") && issue_type === "Story" && story_points !== undefined;
    const testProject = wantsTest ? project() : undefined;
    let sprint = args.sprint_id;
    const create = await writeStep("create ticket", {
      rejected: "Correct the Jira error, then retry create-ticket.",
      uncertain: "Search Jira for the requested issue in the target project. Do not retry creation unless you confirm it does not exist.",
      not_attempted: "Correct the error, then retry create-ticket.",
    }, async () => {
      const claims = new FieldClaims();
      sprint = await resolveSprint(jira, args.sprint_id, args.sprint);
      const payload: IssueFields = {
        project: { key: projectKey }, summary, description: formatDescription(description), issuetype: { name: issue_type },
      };
      if (issue_type === "Bug" || issue_type === "Task" || issue_type === "Story") setLegacyDefaults(payload);
      Object.assign(payload, await fields.forWrite(args, { projectKey, issueType: issue_type }, claims));
      if (issue_type === "Story" && story_points !== undefined) payload.labels = ["QA-Testable"];
      if (parent_epic !== undefined) {
        if (issue_type === "Epic") payload.parent = { key: parent_epic };
        else payload[claims.claim(process.env.JIRA_EPIC_LINK_FIELD?.trim() || "customfield_10014", "JIRA_EPIC_LINK_FIELD")] = parent_epic;
      }
      const assignee = args.assignee ?? (process.env.JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID?.trim() || undefined);
      if (assignee !== undefined) payload.assignee = { accountId: await resolveAssignee(jira, assignee) };
      return createIssue(jira, payload);
    });
    const task = create.state === "done" ? create.value : undefined;
    const key = task?.key;
    if (!wantsSprint && !wantsTest && task) {
      let message = `Created ticket ${task.key} with summary: ${summary}, description: ${description || "No description"}, issue type: ${issue_type}`;
      if (args.acceptance_criteria !== undefined) message += `, acceptance criteria: ${args.acceptance_criteria}`;
      if (story_points !== undefined) message += `, story points: ${story_points}`;
      if (task.omittedFields.length) message += `\nWarning: Jira rejected optional fields; omitted: ${task.omittedFields.join(", ")}`;
      return result(message);
    }
    const afterCreate = "Once the ticket key is confirmed, resume only this step; do not recreate the issue.";
    const move = wantsSprint && key && sprint !== undefined ? await moveStep(jira, key, sprint) : undefined;
    const createTest = testProject && key ? await writeStep("create test ticket", {
      rejected: "Correct the Jira error, use create-ticket for the Test only, then link it to the existing Story using link-tickets.",
      uncertain: "Search for the Test ticket (its summary begins with the Story key); create it only if confirmed absent, then link it to the Story.",
      not_attempted: "Correct the error, use create-ticket for the Test only, then link it to the existing Story using link-tickets.",
    }, () => createIssue(jira, {
      project: { key: testProject }, summary: `${key} ${summary}`, description: formatDescription(summary), issuetype: { name: "Test" },
    }, "create test ticket")) : undefined;
    const test = createTest?.state === "done" ? createTest.value : undefined;
    const link = key && test ? await writeStep("link test ticket", {
      rejected: "Correct the Jira error, then call link-tickets with the two known keys and link_type 'Test Case Linking'.",
      uncertain: "Check issue links before retrying. If the link does not exist, call link-tickets with the two known keys.",
      not_attempted: "Correct the error, then call link-tickets with the two known keys.",
    }, () => linkIssues(jira, key, test.key, "Test Case Linking", "link test ticket")) : undefined;

    return result({
      ticket_key: key, project_key: projectKey, sprint_id: sprint, sprint: args.sprint, test_ticket_key: test?.key, test_project_key: testProject,
      steps: {
        create_ticket: { ...stepReport(create), omitted_fields: task?.omittedFields.length ? task.omittedFields : undefined },
        move_to_sprint: move ? stepReport(move) : skipStep(wantsSprint ? "Ticket or sprint could not be confirmed" : "No sprint requested",
          wantsSprint ? `${afterCreate} Resolve the sprint and call move-ticket-to-sprint.` : undefined),
        create_test_ticket: createTest ? { ...stepReport(createTest), omitted_fields: test?.omittedFields.length ? test.omittedFields : undefined }
          : skipStep(wantsTest ? "Story key not confirmed" : "No linked Test requested", wantsTest ? afterCreate : undefined),
        link_test_ticket: link ? stepReport(link) : skipStep(wantsTest ? "Story or Test key not confirmed" : "No linked Test requested",
          wantsTest ? "Once both keys are confirmed, call link-tickets with link_type 'Test Case Linking'." : undefined),
      },
    }, create.state !== "done" || (wantsSprint && move?.state !== "done") || (wantsTest && link?.state !== "done"));
  });

  tool("update-ticket", "Update an existing Jira ticket", {
    ticket_key,
    summary: z.string().min(1).optional(),
    description: z.string().min(1).optional().describe("Replaces the whole description. Markdown is converted to ADF"),
    sprint: z.string().optional(),
    sprint_id,
    story_readiness: choices,
    story_points: z.number().optional(),
    acceptance_criteria: z.string().optional(),
    crisis: choices,
  }, async (args) => {
    const { ticket_key, summary, description } = args;
    const wantsSprint = args.sprint_id !== undefined || args.sprint !== undefined;
    const wantsUpdate = [summary, description, args.story_points, args.story_readiness, args.acceptance_criteria, args.crisis]
      .some((value) => value !== undefined);
    if (!wantsUpdate && !wantsSprint) throw new OperationError("At least one field or sprint to update must be provided");
    let sprint = args.sprint_id;
    let payload: IssueFields;
    try {
      const claims = new FieldClaims();
      sprint = await resolveSprint(jira, sprint, args.sprint);
      payload = await fields.forWrite(args, { ticketKey: ticket_key }, claims);
      if (summary !== undefined) payload.summary = summary;
      if (description !== undefined) payload.description = formatDescription(description);
    } catch (error) {
      return result({ ticket_key, sprint_id: sprint, sprint: args.sprint, ...errorDetails(error, "prepare ticket update"), steps: {
        update_ticket: skipStep(wantsUpdate ? "Validation or preparation failed" : "No issue fields requested"),
        move_to_sprint: skipStep(wantsSprint ? "Validation or preparation failed" : "No sprint requested"),
      }, recovery: "Correct the error, then retry update-ticket." }, true);
    }
    const update = wantsUpdate ? await writeStep("update ticket", {
      rejected: "Correct the Jira error, then retry the update.",
      uncertain: "Check the ticket's fields before retrying. Apply only changes that were not saved; the sprint move was not attempted.",
      not_attempted: "Correct the error, then retry the update.",
    }, () => jira.put("update ticket", issuePath(ticket_key), { fields: payload })) : undefined;
    const move = sprint !== undefined && (!update || update.state === "done") ? await moveStep(jira, ticket_key, sprint) : undefined;
    if (!wantsSprint && update?.state === "done") return result(`Successfully updated ticket ${ticket_key}`);
    return result({ ticket_key, sprint_id: sprint, sprint: args.sprint, steps: {
      update_ticket: update ? stepReport(update) : skipStep("No issue fields requested"),
      move_to_sprint: move ? stepReport(move) : skipStep(wantsSprint ? "Issue update was not confirmed" : "No sprint requested",
        wantsSprint ? "Once the issue fields are correct, call move-ticket-to-sprint separately." : undefined),
    } }, (wantsUpdate && update?.state !== "done") || (wantsSprint && move?.state !== "done"));
  });

  tool("get-ticket", "Get compact Jira ticket details or the full Jira fields with raw: true", {
    ticket_id: z.string().min(1, "Ticket ID is required"), raw: z.boolean().optional(),
  }, async ({ ticket_id, raw }) => result(await getTicket(jira, fields, ticket_id, raw)));

  tool("search-tickets", "Search for Jira tickets by issue type", {
    issue_type, ...searchPage, additional_criteria: z.string().optional(),
  }, async ({ issue_type, max_results = 10, additional_criteria, next_page_token }) => {
    let jql = `project = ${JSON.stringify(project())} AND issuetype = "${issue_type}"`;
    if (additional_criteria) jql += ` AND (${additional_criteria})`;
    return result(await searchTickets(jira, jql, max_results, "summary,status,priority", next_page_token));
  });

  tool("search-tickets-jql", "Search for Jira tickets using custom JQL", {
    jql: z.string().min(1, "JQL query is required"), ...searchPage,
    fields: z.string().optional().describe("Comma-separated list of fields, or *all. Omit for the compact default fields."),
  }, async ({ jql, max_results = 10, fields, next_page_token }) =>
    result(await searchTickets(jira, jql, max_results, fields?.trim() || searchFields, next_page_token)));

  tool("link-tickets", "Link two Jira tickets", {
    outward_issue: z.string().min(1, "Outward issue key is required"),
    inward_issue: z.string().min(1, "Inward issue key is required"),
    link_type: z.string().min(1, "Link type is required").default("Test Case Linking"),
  }, async ({ outward_issue, inward_issue, link_type }) => {
    await linkIssues(jira, outward_issue, inward_issue, link_type);
    return result(`Successfully linked ${outward_issue} to ${inward_issue} with link type "${link_type}"`);
  });

  tool("remove-issue-link", "Remove a link between two Jira tickets by link ID", {
    link_id: z.string().min(1, "Link ID is required"),
  }, async ({ link_id }) => {
    await jira.delete("remove issue link", `/rest/api/3/issueLink/${pathSegment(link_id)}`);
    return result(`Link ${link_id} removed successfully`);
  });

  const comment_id = z.string().min(1, "Comment ID is required");
  tool("add-comment", "Add a comment to a Jira ticket", {
    ticket_key, body: z.string().min(1, "Comment body is required"),
  }, async ({ ticket_key, body }) => {
    const comment = await jira.post<{ id?: string }>("add comment", `${issuePath(ticket_key)}/comment`, { body: formatJiraContent(body) });
    if (!comment?.id) throw new OperationError("add comment: Jira did not return an ID; check the comments before retrying");
    return result(`Comment added successfully to ${ticket_key} (id: ${comment.id})`);
  });

  tool("edit-comment", "Edit an existing comment on a Jira ticket", {
    ticket_key, comment_id, body: z.string().min(1, "New comment body is required"),
  }, async ({ ticket_key, comment_id, body }) => {
    await jira.put("edit comment", `${issuePath(ticket_key)}/comment/${pathSegment(comment_id)}`, { body: formatJiraContent(body) });
    return result(`Comment ${comment_id} on ${ticket_key} updated successfully`);
  });

  tool("delete-comment", "Delete a comment from a Jira ticket. This cannot be undone", {
    ticket_key, comment_id,
  }, async ({ ticket_key, comment_id }) => {
    await jira.delete("delete comment", `${issuePath(ticket_key)}/comment/${pathSegment(comment_id)}`);
    return result(`Comment ${comment_id} on ${ticket_key} deleted successfully`);
  });

  tool("get-sprints", "List sprints for a Jira board", {
    board_id: z.number().int().positive().safe(),
    state: z.enum(["active", "future", "closed"]).optional().describe("Filter by sprint state (default: active)"),
  }, async ({ board_id, state = "active" }) => result({ board_id, state, sprints: await getSprints(jira, board_id, state) }));

  tool("move-ticket-to-sprint", "Move a Jira ticket to an active or future sprint", {
    ticket_key, sprint_id: sprint_id.unwrap(),
  }, async ({ ticket_key, sprint_id }) => result(await moveToSprint(jira, ticket_key, sprint_id)));

  tool("transition-ticket", "List or apply a Jira ticket workflow transition", {
    ticket_key,
    transition_name: z.string().optional(),
    transition_id: z.string().optional(),
    list_transitions: z.boolean().optional(),
    comment: z.string().optional(),
  }, async ({ ticket_key, transition_name, transition_id, list_transitions, comment }) => {
    const path = `${issuePath(ticket_key)}/transitions`;
    const page = await jira.get<{ transitions: { id: string; name: string; to: { name: string }; fields?: Record<string, { required?: boolean }> }[] }>(
      "list ticket transitions", path, { expand: "transitions.fields" },
    );
    if (!Array.isArray(page?.transitions)) throw new OperationError("list ticket transitions: no transitions returned by Jira");
    const transitions = page.transitions.map(({ id, name, to, fields }) => ({
      id, name, to: to.name, required_fields: Object.entries(fields ?? {}).filter(([, field]) => field.required).map(([key]) => key),
    }));
    const name = transition_name?.trim().toLowerCase();
    if (transition_id !== undefined && name !== undefined && !transitions.some((t) => t.id === transition_id && t.name.toLowerCase() === name)) {
      return result({ operation: "transition-ticket", ticket_key, error: "transition_id and transition_name do not identify the same available transition", transitions }, true);
    }
    if (list_transitions || (transition_id === undefined && transition_name === undefined)) return result({ ticket_key, transitions });
    const matches = transitions.filter((t) => transition_id !== undefined ? t.id === transition_id : t.name.toLowerCase() === name);
    if (matches.length !== 1) return result({
      operation: "transition-ticket", ticket_key, error: matches.length ? "Transition name is ambiguous; use transition_id" : "Transition is not available",
      transitions: matches.length ? matches : transitions,
    }, true);
    const [target] = matches;
    const applied = await writeStep("apply ticket transition", {
      rejected: "Correct the Jira error and recheck available transitions before retrying.",
      uncertain: "Check the current Jira status and any transition comment before retrying the transition.",
      not_attempted: "Correct the error and recheck available transitions before retrying.",
    }, () => jira.command("apply ticket transition", path, {
      transition: { id: target.id },
      ...(comment && { update: { comment: [{ add: { body: formatJiraContent(comment) } }] } }),
    }));
    const identity = { ticket_key, transition_id: target.id };
    if (applied.state !== "done") return result({ ...identity, transition: stepReport(applied) }, true);

    const operation = "read status after transition";
    try {
      const issue = await jira.get<{ fields?: { status?: { name?: string } } }>(operation, issuePath(ticket_key), { fields: "status" });
      const status = issue?.fields?.status?.name;
      if (!status) throw new OperationError("Jira did not return the current status");
      return result({ ...identity, status });
    } catch (error) {
      return result({ ...identity, transition: stepReport(applied), ...errorDetails(error, operation),
        recovery: "The transition was accepted. Read the ticket status again; do not repeat the transition." }, true);
    }
  });

  server.tool("get-myself", "Get the current Jira user's account ID and display name", () =>
    runTool("get-myself", async () => result(await getMyself(jira))));

  tool("assign-ticket", "Assign or unassign a Jira ticket", {
    ticket_key, assignee: z.string().describe("Atlassian account ID, me, or unassigned"),
  }, async ({ ticket_key, assignee }) => {
    const accountId = await resolveAssignee(jira, assignee);
    await jira.put("assign ticket", `${issuePath(ticket_key)}/assignee`, { accountId });
    return result({ ticket_key, accountId });
  });

  tool("add-worklog", "Log time on a Jira ticket using a duration in seconds or Jira duration text", {
    ticket_key,
    time_spent: z.string().min(1).optional().describe("Jira duration, e.g. 2h 30m or 1d"),
    time_spent_seconds: z.number().int().positive().safe().optional(),
    started: z.string().datetime({ offset: true }).refine((date) => Number.isFinite(Date.parse(date)), "Invalid timestamp")
      .optional().describe("ISO 8601 timestamp with a timezone"),
    comment: z.string().optional(),
  }, async ({ ticket_key, time_spent, time_spent_seconds, started, comment }) => {
    if ((time_spent === undefined) === (time_spent_seconds === undefined) || (time_spent !== undefined && !time_spent.trim())) {
      throw new OperationError("Provide exactly one non-empty time_spent or positive time_spent_seconds");
    }
    const log = await jira.post<{ id?: string; started?: string; timeSpentSeconds?: number; timeSpent?: string }>(
      "add worklog", `${issuePath(ticket_key)}/worklog`, {
        timeSpent: time_spent, timeSpentSeconds: time_spent_seconds,
        started: started && new Date(started).toISOString().replace(/Z$/, "+0000"),
        ...(comment && { comment: formatJiraContent(comment) }),
      },
    );
    if (!log?.id) throw new OperationError("add worklog: Jira did not return an ID; check the worklogs before retrying");
    return result({ ticket_key, id: log.id, started: log.started, timeSpentSeconds: log.timeSpentSeconds, timeSpent: log.timeSpent });
  });

  tool("list-worklogs", "List one page of worklogs on a Jira ticket", {
    ticket_key, start_at: z.number().int().nonnegative().safe().optional(), max_results: z.number().int().min(1).max(100).optional(),
  }, async ({ ticket_key, start_at = 0, max_results = 20 }) => result(await listWorklogs(jira, ticket_key, start_at, max_results)));

  tool("get-test-steps", "Get test steps from a test ticket via Zephyr integration", { ticket_key }, async ({ ticket_key }) => {
    const { issueId, projectId } = await getJiraTestIds(jira, ticket_key);
    const steps = await getZephyrTestSteps(issueId, projectId);
    return result(steps.length ? `Found ${steps.length} test step(s) for ticket ${ticket_key}:\n\n${JSON.stringify(steps, null, 2)}`
      : `No test steps found for ticket ${ticket_key}.`);
  });

  tool("add-test-steps", "Add test steps to a test ticket via Zephyr integration", {
    ticket_key,
    steps: z.array(z.object({
      step: z.string().min(1, "Step description is required"), data: z.string().optional(), result: z.string().optional(),
    })).min(1, "At least one test step is required"),
  }, async ({ ticket_key, steps }) => {
    const batchResult = (text: string, details: object, failed: boolean) => {
      const response = result(text, failed);
      response.content.push({ type: "text", text: JSON.stringify({ ticket_key, ...details }, null, 2) });
      return response;
    };
    let ids: Awaited<ReturnType<typeof getJiraTestIds>>;
    try {
      ids = await getJiraTestIds(jira, ticket_key);
    } catch (error) {
      const details = errorDetails(error, "resolve Jira test ticket IDs");
      return batchResult(`Error getting internal ID for ticket ${ticket_key}: ${details.error}`, {
        ...details,
        steps: steps.map((_, index) => ({ step: index + 1, ...skipStep("Issue and project IDs could not be resolved",
          "Correct the Jira error, then retry the batch; no step was sent.") })),
      }, true);
    }
    const results: string[] = [];
    const reports = [];
    let stop = false;
    for (const [index, step] of steps.entries()) {
      if (stop) {
        results.push(`Step ${index + 1}: Not attempted`);
        reports.push({ step: index + 1, ...skipStep("Stopped after an earlier step was not confirmed",
          "Resolve the earlier step first, then submit only remaining steps that are missing from Zephyr.") });
        continue;
      }
      const added = await writeStep("add Zephyr test step", {
        rejected: "Correct the Zephyr error, then submit only the rejected step; check its position in the step order.",
        uncertain: "Call get-test-steps and check the saved steps and their order before retrying. Do not replay the batch.",
        not_attempted: "Correct the error, then submit only the steps that were not attempted.",
      }, () => addZephyrTestStep(ids.issueId, ids.projectId, step));
      reports.push({ step: index + 1, ...stepReport(added) });
      if (added.state === "done") {
        results.push(`Step ${index + 1}: Added successfully`);
      } else if (added.state === "rejected" && added.status !== undefined) {
        results.push(`Step ${index + 1}: Failed - Status: ${added.status} ${STATUS_CODES[added.status] ?? ""}`.trimEnd());
      } else {
        stop = true;
        results.push(`Step ${index + 1}: ${added.state === "uncertain" ? "Outcome uncertain" : "Not attempted"} - ${added.error}`);
      }
    }
    const failed = reports.some(({ state }) => state !== "done");
    const heading = failed ? `Some test steps could not be added to ticket ${ticket_key}`
      : `Successfully added ${steps.length} test step(s) to ticket ${ticket_key}`;
    return batchResult(`${heading}:\n\n${results.join("\n")}`, { steps: reports }, failed);
  });
}
