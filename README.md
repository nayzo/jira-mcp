# jira-mcp

MCP server for Jira Cloud — tailored for ALM projects with Zephyr Scale integration.

Built on the [Model Context Protocol](https://modelcontextprotocol.io/) SDK (TypeScript). Runs as a local stdio process used by Claude Code.

---

## Setup

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
| `JIRA_HOST` | ✅ | e.g. `your-company.atlassian.net` |
| `JIRA_USERNAME` | ✅ | Your Atlassian email |
| `JIRA_API_TOKEN` | ✅ | API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | ✅ | e.g. `ALM` |
| `ZEPHYR_API_TOKEN` | — | Required for test step tools |
| `AUTO_CREATE_TEST_TICKETS` | — | Auto-create Test ticket when a Story has points (default: `true`) |

Custom field IDs (story points, acceptance criteria, epic link, etc.) are configurable via env — see `.env.dist`.

---

## Tools

### Issues

| Tool | Description |
|---|---|
| `create-ticket` | Create a ticket (Bug, Story, Task, Test) with full field support |
| `get-ticket` | Get ticket details |
| `update-ticket` | Update any field: summary, description, labels, priority, assignee, sprint… |
| `search-tickets` | Search by issue type with optional JQL criteria |
| `search-tickets-jql` | Free JQL search |
| `transition-ticket` | Move a ticket through its workflow (with optional comment) |
| `assign-ticket` | Assign or unassign a ticket |
| `get-issue-history` | Full changelog of a ticket |
| `get-related-issues` | Linked issues (blocks, is blocked by, relates to…) |
| `get-dev-info` | PRs, branches and commits linked via GitHub integration |

### Comments & Time

| Tool | Description |
|---|---|
| `add-comment` | Add a comment (Markdown → ADF) |
| `list-comments` | List comments on a ticket |
| `add-worklog` | Log time spent (`2h 30m`, `1d`…) with optional comment |

### Watchers

| Tool | Description |
|---|---|
| `add-watcher` | Add a watcher by account ID |
| `remove-watcher` | Remove a watcher by account ID |

### Links

| Tool | Description |
|---|---|
| `link-tickets` | Create a link between two tickets |

### Sprints

| Tool | Description |
|---|---|
| `get-sprints` | List sprints for a board (`active` / `future` / `closed`) |

### Zephyr Scale (test steps)

| Tool | Description |
|---|---|
| `get-test-steps` | Get test steps from a Test ticket |
| `add-test-steps` | Add test steps to a Test ticket |

---

## Markdown support

Descriptions and comments accept Markdown — converted to Atlassian Document Format (ADF) automatically:

- `## Heading` / `### Sub-heading`
- `- bullet list`
- `` `inline code` ``
- `**bold**`

---

## Development

```bash
npm run build      # Compile TypeScript → build/
```

Restart Claude (or `/mcp`) to pick up a new build.
