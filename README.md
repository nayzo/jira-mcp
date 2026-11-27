# jira-mcp

MCP server for Jira Cloud, with Zephyr Squad Cloud test-step support.

Built on the [Model Context Protocol](https://modelcontextprotocol.io/) SDK (TypeScript). Runs as a local stdio process.

---

## Setup

Requires Node.js 18 or newer.

```bash
cp .env.dist .env
# Fill in your values in .env
npm install
npm run build
```

Then register in your Claude config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/path/to/jira-mcp/build/index.js"]
    }
  }
}
```

---

## Configuration

See `.env.dist` for all available variables.

| Variable | Required | Description |
|---|---|---|
| `JIRA_HOST` | Yes | Jira host without scheme or path, e.g. `your-company.atlassian.net` |
| `JIRA_USERNAME` | Yes | Your Atlassian email |
| `JIRA_API_TOKEN` | Yes | API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | No | Default project, e.g. `ALM` (fallback: `SCRUM`) |
| `JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID` | No | Default for `create-ticket`; an explicit `assignee` takes precedence |
| `JIRA_SPRINT_BOARD_ID` | For sprint names | Board on which to resolve the legacy `sprint` name. Prefer `sprint_id`. |
| `JIRA_SPRINT_FIELD` | No | Sprint field ID for reads only |
| `JIRA_STORY_POINTS_FIELD`, `JIRA_ACCEPTANCE_CRITERIA_FIELD` | No | Story points and acceptance criteria custom field IDs |
| `JIRA_STORY_READINESS_FIELD`, `JIRA_CRISIS_FIELD` | No | Story readiness and crisis custom field IDs |
| `JIRA_STORY_READINESS_YES_ID`, `JIRA_STORY_READINESS_NO_ID` | No | Story readiness option IDs |
| `JIRA_CRISIS_YES_ID`, `JIRA_CRISIS_NO_ID` | No | Crisis option IDs |
| `ZAPI_ACCESS_KEY`, `ZAPI_SECRET_KEY` | For Zephyr tools | Zephyr Squad Cloud credentials |
| `ZAPI_BASE_URL`, `ZAPI_ACCOUNT_ID` | No | Override the Zephyr endpoint or include the Atlassian account ID in the JWT |
| `AUTO_CREATE_TEST_TICKETS` | No | Auto-create a Test ticket when a Story has points (default: `true`) |

If an ID override is unset, the server looks for the exact field name (case-insensitive): `Story Points`, `Acceptance Criteria`, `Story Readiness`, `Crisis`, or `Sprint`. The field catalogue is cached for five minutes per server connection configuration. Use a `customfield_<id>` override for alternate names (such as `Story point estimate`) or duplicates. When a Yes/No option ID is unset, the server resolves it from the issue's creation or edit metadata. Configured IDs must be valid for the target Jira screen and field context. See `.env.dist` for legacy product, category and epic link settings, or `jira-mcp-config-template.json` for an MCP configuration example.

When upgrading, verify the old default IDs against your tenant. If discovery cannot find the field by name, set `JIRA_STORY_POINTS_FIELD` (previously `customfield_10040`), `JIRA_ACCEPTANCE_CRITERIA_FIELD` (previously `customfield_10429`) or `JIRA_STORY_READINESS_FIELD` (previously `customfield_10596`) to the verified ID. The old readiness option IDs (`18256` and `18257`) are no longer assumed; set `JIRA_STORY_READINESS_YES_ID` and `JIRA_STORY_READINESS_NO_ID` only if they are valid for the target context. Do not reuse the old Sprint write ID (`customfield_10020`): sprint moves use Jira Agile, and `JIRA_SPRINT_FIELD` is a separate read-only override. Each field variable must identify a different field. If Jira rejects an optional legacy product or category field and creation succeeds after omitting it, `create-ticket` names the omitted field in its response.

---

## Tools

### Issues

| Tool | Description |
|---|---|
| `create-ticket` | Create a Bug, Story, Task, Test or Epic; accepts `assignee` and `sprint_id` |
| `get-ticket` | Compact issue details, five latest comments and a worklog summary. If sprint, comments or worklogs are unavailable, the response keeps the available data and includes `warnings`. `raw: true` returns the original complete `fields` output. |
| `update-ticket` | Update summary, description, story points, acceptance criteria, story readiness, crisis or sprint |
| `search-tickets` | Search by issue type with optional JQL criteria |
| `search-tickets-jql` | JQL search with comma-separated `fields` (`*all` for all fields), or a compact default |
| `transition-ticket` | List transitions when no target is provided; apply by `transition_id` or unambiguous `transition_name` with optional `comment`, then read the current Jira status. If both selectors are set, they must agree. |
| `assign-ticket` | Set `assignee` to an account ID, `me` or `unassigned`; the same values work in `create-ticket` |
| `get-myself` | Get the authenticated Jira account ID and display name |

Both search tools return a page `count`, not a global total. If the response includes `next_page_token`, pass it back with the same search arguments to continue, even if the current page is empty.

### Comments & Time

| Tool | Description |
|---|---|
| `add-comment` | Add a comment with `body` (Markdown to ADF) |
| `edit-comment` | Edit a comment by ID with `body` |
| `delete-comment` | Delete a comment by ID (cannot be undone) |
| `add-worklog` | Pass one of `time_spent_seconds` or `time_spent` (e.g. `2h 30m`), optionally `started` (ISO 8601 with timezone) and `comment` |
| `list-worklogs` | Get a page of worklogs for `ticket_key`, with optional `start_at` and `max_results`; use `next_start_at` to continue |

### Links

| Tool | Description |
|---|---|
| `link-tickets` | Create a link between two tickets |
| `remove-issue-link` | Delete a link by `link_id` |

### Sprints

| Tool | Description |
|---|---|
| `get-sprints` | List sprints across pages for a board (`active` by default; also `future` or `closed`) |
| `move-ticket-to-sprint` | Move `ticket_key` to an active or future `sprint_id` via Jira Agile |

`create-ticket` and `update-ticket` move the ticket after the issue write. The legacy `sprint` name requires `JIRA_SPRINT_BOARD_ID` and a unique match on that board. A requested linked Test is still created and linked if the Story was created but its sprint move failed.

Multi-step writes report a state for each step: `done`, `rejected` (confirmed HTTP refusal), `uncertain` (for example, a timeout or HTTP 5xx), or `not_attempted`. Use the returned keys and `recovery` instructions to resume the relevant step. If a sprint move is uncertain, verify the current sprint in Jira before calling `move-ticket-to-sprint` again. Do not recreate a ticket whose creation was confirmed.

### Zephyr Squad Cloud (test steps)

| Tool | Description |
|---|---|
| `get-test-steps` | Get test steps from a Test ticket |
| `add-test-steps` | Add test steps to a Test ticket. The first text block keeps the historical summary; the second contains JSON states and recovery instructions. After an uncertain write, remaining steps are not attempted. |

---

## Markdown support

Descriptions and comments accept Markdown and are converted to Atlassian Document Format (ADF):

- `## Heading` / `### Sub-heading`
- `- bullet list`
- `` `inline code` ``
- `**bold**`
- fenced code blocks and links, `[label](url)` or bare URLs

---

## Development

```bash
npm run build      # Compile TypeScript → build/
npm test           # Build and test MCP stdio against mocked HTTP responses
```

Restart Claude (or `/mcp`) to pick up a new build.
