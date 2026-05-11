import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root (parent of src or build directory)
const envPath = path.resolve(__dirname, "..", ".env");
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error(`[JIRA-MCP] Error loading .env:`, result.error);
}
if (process.env.DEBUG === "true") {
  console.error(`[JIRA-MCP] Loading .env from: ${envPath}`);
  console.error(`[JIRA-MCP] JIRA_HOST: ${process.env.JIRA_HOST || 'NOT SET'}`);
  console.error(`[JIRA-MCP] JIRA_USERNAME: ${process.env.JIRA_USERNAME ? 'SET' : 'NOT SET'}`);
  console.error(`[JIRA-MCP] JIRA_API_TOKEN: ${process.env.JIRA_API_TOKEN ? 'SET' : 'NOT SET'}`);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { fetchWithRetry } from "./http.js";
import { updateJiraTicket } from "./update-ticket.js";
import { getZephyrTestSteps } from "./get-zephyr-test-steps.js";

// Define types for JIRA and Zephyr responses
type JiraCreateResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  key?: string;
  id?: string;
};

type JiraGetResponse = {
  errorMessages?: string[];
  id?: string; // Internal Jira ID
  fields?: {
    summary: string;
    description?: any;
    issuetype: {
      name: string;
    };
    status?: {
      name: string;
    };
    priority?: {
      name: string;
    };
    [key: string]: any; // Allow for custom fields
  };
  [key: string]: any;
};

type JiraSearchResponse = {
  errorMessages?: string[];
  issues?: Array<{
    key: string;
    fields: {
      summary: string;
      description?: any;
      issuetype: {
        name: string;
      };
      status?: {
        name: string;
      };
      priority?: {
        name: string;
      };
      [key: string]: any; // Allow for custom fields
    };
  }>;
  // Legacy pagination fields (may still be present for backward compatibility)
  total?: number;
  maxResults?: number;
  startAt?: number;
  // New pagination fields for /search/jql endpoint
  isLast?: boolean;
  nextPageToken?: string;
};

type ZephyrAddTestStepResponse = {
  id?: number;
  orderId?: number;
  step?: string;
  data?: string;
  result?: string;
  [key: string]: any;
};

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

// Helper function to generate a JWT token for Zephyr API
function generateZephyrJwt(
  method: string,
  apiPath: string,
  queryParams: Record<string, string> = {},
  expirationSec: number = 3600
): string {
  // Sort query parameters alphabetically
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((key) => `${key}=${queryParams[key]}`)
    .join("&");

  // Build the canonical string: METHOD&<path>&<query>
  const canonical = `${method.toUpperCase()}&${apiPath}&${canonicalQuery}`;

  // Create SHA-256 hex hash of canonical string
  const qsh = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  // Timestamps
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expirationSec;

  // JWT claims
  const payload = {
    sub: process.env.ZAPI_ACCOUNT_ID, // Atlassian account ID
    iss: process.env.ZAPI_ACCESS_KEY, // Zephyr Access Key
    qsh, // query-string hash
    iat: now,
    exp,
  };

  // Sign with HMAC-SHA256 using Zephyr Secret Key
  return jwt.sign(payload, process.env.ZAPI_SECRET_KEY || "", {
    algorithm: "HS256",
  });
}

// Helper function to add a test step to a Zephyr test
async function addZephyrTestStep(
  issueId: string,
  projectId: string,
  step: string,
  data: string = "",
  result: string = ""
): Promise<{
  success: boolean;
  data?: ZephyrAddTestStepResponse;
  errorMessage?: string;
}> {
  const baseUrl =
    process.env.ZAPI_BASE_URL ||
    "https://prod-api.zephyr4jiracloud.com/connect";
  const apiPath = `/public/rest/api/1.0/teststep/${issueId}`;

  const queryParams = { projectId };

  const queryString = Object.keys(queryParams)
    .map((key) => `${key}=${queryParams[key as keyof typeof queryParams]}`)
    .join("&");

  const fullUrl = `${baseUrl}${apiPath}?${queryString}`;

  if (process.env.DEBUG === "true") {
    console.error("[JIRA-MCP] Zephyr URL:", fullUrl);
    console.error("[JIRA-MCP] Zephyr Payload:", JSON.stringify({ projectId, step, data, result }, null, 2));
  }

  try {
    const jwtToken = generateZephyrJwt("POST", apiPath, queryParams);

    const response = await fetchWithRetry(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        zapiAccessKey: process.env.ZAPI_ACCESS_KEY || "",
        Authorization: `JWT ${jwtToken}`,
      },
      body: JSON.stringify({ projectId, step, data, result }),
    });

    const responseData = (await response.json()) as ZephyrAddTestStepResponse;

    if (!response.ok) {
      console.error(
        "Error adding test step:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      return {
        success: false,
        data: responseData,
        errorMessage: `Status: ${response.status} ${response.statusText}`,
      };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception adding test step:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Auto-create test tickets setting
const autoCreateTestTickets = process.env.AUTO_CREATE_TEST_TICKETS !== "false";

// Create server instance
const server = new McpServer({
  name: "jira-mcp",
  version: "1.0.0",
});

// Convert Markdown / Jira-wiki text to an ADF document node
function markdownToAdf(text: string): any {
  const lines = text.split("\n");
  const nodes: any[] = [];
  let bulletItems: any[] = [];

  const flushBullets = () => {
    if (bulletItems.length > 0) {
      nodes.push({ type: "bulletList", content: bulletItems });
      bulletItems = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }

    // Markdown heading: ## Title, ### Title, etc.
    const mdHeading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    // Jira wiki markup: h2. Title, h3. Title, etc.
    const jiraHeading = trimmed.match(/^h([1-6])\.\s+(.+)$/);

    if (mdHeading) {
      flushBullets();
      const level = mdHeading[1].length;
      nodes.push({
        type: "heading",
        attrs: { level },
        content: [{ type: "text", text: mdHeading[2] }],
      });
    } else if (jiraHeading) {
      flushBullets();
      const level = parseInt(jiraHeading[1], 10);
      nodes.push({
        type: "heading",
        attrs: { level },
        content: [{ type: "text", text: jiraHeading[2] }],
      });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletItems.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: trimmed.substring(2).trim() }],
          },
        ],
      });
    } else {
      flushBullets();
      nodes.push({
        type: "paragraph",
        content: [{ type: "text", text: trimmed }],
      });
    }
  }

  flushBullets();

  return {
    type: "doc",
    version: 1,
    content:
      nodes.length > 0
        ? nodes
        : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
}

// Helper function to format text content for JIRA API v3
function formatJiraContent(
  content: string | undefined,
  defaultText: string = "No content provided"
): any {
  if (!content) {
    return {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: defaultText }] },
      ],
    };
  }
  return markdownToAdf(content);
}

// Helper function to format description for JIRA API v3
function formatDescription(description: string | undefined) {
  return formatJiraContent(description, "No description provided");
}

// Helper function to format acceptance criteria for JIRA API v3
function formatAcceptanceCriteria(criteria: string | undefined) {
  return formatJiraContent(criteria, "No acceptance criteria provided");
}

// Helper function to create a JIRA ticket
async function createJiraTicket(
  payload: any,
  auth: string
): Promise<{
  success: boolean;
  data: JiraCreateResponse;
  errorMessage?: string;
}> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue`;

  if (process.env.DEBUG === "true") {
    console.error("[JIRA-MCP] JIRA URL:", jiraUrl);
    console.error("[JIRA-MCP] JIRA Payload:", JSON.stringify(payload, null, 2));
    console.error("[JIRA-MCP] JIRA Auth:", `Basic ${auth.substring(0, 10)}...`);
    console.error("[JIRA-MCP] JIRA Project Key:", process.env.JIRA_PROJECT_KEY);
  }

  try {
    const response = await fetchWithRetry(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = (await response.json()) as JiraCreateResponse;

    if (!response.ok) {
      console.error(
        "Error creating ticket:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      // Check if it's a custom field validation error
      if (response.status === 400 && responseData.errors) {
        const productField = process.env.JIRA_PRODUCT_FIELD;
        const categoryField = process.env.JIRA_CATEGORY_FIELD;

        const hasProductFieldError = productField && responseData.errors[productField];
        const hasCategoryFieldError = categoryField && responseData.errors[categoryField];

        if (hasProductFieldError) {
          const errorMessage = responseData.errors[productField];
          if (process.env.DEBUG === "true") {
            console.error(`[JIRA-MCP] Product field error: ${errorMessage}`);
          }

          const productValue = process.env.JIRA_PRODUCT_VALUE;
          const productId = process.env.JIRA_PRODUCT_ID;

          if (productValue && productId) {
            if (process.env.DEBUG === "true") {
              console.error("[JIRA-MCP] Retrying with alternative product field formats...");
            }

            // Try format 1: Just the ID as string
            let retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = productId;

            let retryResponse = await fetchWithRetry(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              return { success: true, data: retryResponseData };
            }

            // Try format 2: Array with just ID
            retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = [{ id: productId }];

            retryResponse = await fetchWithRetry(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              return { success: true, data: retryResponseData };
            }

            // Try format 3: Array with just value
            retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = [{ value: productValue }];

            retryResponse = await fetchWithRetry(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              return { success: true, data: retryResponseData };
            }

            if (process.env.DEBUG === "true") {
              console.error("[JIRA-MCP] All product field format retries failed");
            }
          }

          if (errorMessage.toLowerCase().includes('required')) {
            console.error(`Required product field ${productField} validation failed with all formats.`);
            return {
              success: false,
              data: responseData,
              errorMessage: `Required field validation failed: ${errorMessage}. The product ID "${productId}" or value "${productValue}" may be invalid for your JIRA instance.`
            };
          }
        }

        // For non-required field errors, try removing them
        if ((hasProductFieldError && !responseData.errors[productField].toLowerCase().includes('required')) || hasCategoryFieldError) {
          if (process.env.DEBUG === "true") {
            console.error("[JIRA-MCP] Retrying ticket creation without problematic custom fields...");
          }

          const retryPayload = JSON.parse(JSON.stringify(payload));

          if (hasProductFieldError && !responseData.errors[productField].toLowerCase().includes('required')) {
            delete retryPayload.fields[productField];
          }

          if (hasCategoryFieldError) {
            delete retryPayload.fields[categoryField];
          }

          const retryResponse = await fetchWithRetry(jiraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify(retryPayload),
          });

          const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;

          if (retryResponse.ok) {
            return { success: true, data: retryResponseData };
          } else {
            console.error("Retry also failed:", JSON.stringify(retryResponseData, null, 2));
          }
        }
      }

      let errorMessage = `Status: ${response.status} ${response.statusText}`;

      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      } else if (responseData.errors) {
        errorMessage = JSON.stringify(responseData.errors);
      }

      return { success: false, data: responseData, errorMessage };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception creating ticket:", error);
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to create a link between two tickets
async function createTicketLink(
  outwardIssue: string,
  inwardIssue: string,
  linkType: string,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issueLink`;

  const payload = {
    outwardIssue: { key: outwardIssue },
    inwardIssue: { key: inwardIssue },
    type: { name: linkType },
  };

  if (process.env.DEBUG === "true") {
    console.error("[JIRA-MCP] Creating link between", outwardIssue, "and", inwardIssue);
    console.error("[JIRA-MCP] Link payload:", JSON.stringify(payload, null, 2));
  }

  try {
    const response = await fetchWithRetry(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseData = await response.json();
      console.error(
        "Error creating link:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      return { success: false, errorMessage: `Status: ${response.status} ${response.statusText}` };
    }

    return { success: true };
  } catch (error) {
    console.error("Exception creating link:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to search for JIRA tickets
async function searchJiraTickets(
  jql: string,
  maxResults: number,
  auth: string,
  fields?: string
): Promise<{
  success: boolean;
  data: JiraSearchResponse;
  errorMessage?: string;
}> {
  let jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`;
  if (fields) {
    jiraUrl += `&fields=${encodeURIComponent(fields)}`;
  }

  if (process.env.DEBUG === "true") {
    console.error("[JIRA-MCP] JIRA Search URL:", jiraUrl);
    console.error("[JIRA-MCP] JIRA Search JQL:", jql);
  }

  try {
    const response = await fetchWithRetry(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraSearchResponse;

    if (!response.ok) {
      console.error(
        "Error searching tickets:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      let errorMessage = `Status: ${response.status} ${response.statusText}`;

      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      }

      return { success: false, data: responseData, errorMessage };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception searching tickets:", error);
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to get the internal Jira ID and project ID from a ticket key
async function getJiraIssueId(
  ticketKey: string,
  auth: string
): Promise<{
  success: boolean;
  id?: string;
  projectId?: string;
  errorMessage?: string;
}> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}`;

  try {
    const response = await fetchWithRetry(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraGetResponse;

    if (!response.ok) {
      console.error("Error fetching ticket:", responseData);

      let errorMessage = `Status: ${response.status} ${response.statusText}`;
      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      }

      return { success: false, errorMessage };
    }

    if (!responseData.id) {
      return {
        success: false,
        errorMessage: "No issue ID found in response",
      };
    }

    const projectId = responseData.fields?.project?.id;
    if (!projectId && process.env.DEBUG === "true") {
      console.error("[JIRA-MCP] Warning: Project ID not found in response");
    }

    return {
      success: true,
      id: responseData.id,
      projectId,
    };
  } catch (error) {
    console.error("Exception fetching ticket ID:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Register JIRA tools
server.tool(
  "create-ticket",
  "Create a jira ticket",
  {
    summary: z.string().min(1, "Summary is required"),
    issue_type: z
      .enum(["Bug", "Task", "Story", "Test", "Epic"])
      .default("Task"),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    story_points: z.number().optional(),
    create_test_ticket: z.boolean().optional(),
    parent_epic: z.string().optional(),
    sprint: z.string().optional(),
    story_readiness: z.enum(["Yes", "No"]).optional(),
    project_key: z.string().optional(),
    crisis: z.enum(["Yes", "No"]).optional(),
  },
  async ({
    summary,
    issue_type,
    description,
    acceptance_criteria,
    story_points,
    create_test_ticket,
    parent_epic,
    sprint,
    story_readiness,
    project_key,
    crisis,
  }) => {
    const formattedDescription = formatDescription(description);

    const shouldCreateTestTicket =
      create_test_ticket !== undefined
        ? create_test_ticket
        : autoCreateTestTickets;

    const payload: any = {
      fields: {
        project: {
          key: project_key || process.env.JIRA_PROJECT_KEY || "SCRUM",
        },
        summary: summary,
        description: formattedDescription,
        issuetype: {
          name: issue_type,
        },
      },
    };

    if (acceptance_criteria !== undefined) {
      const acceptanceCriteriaField =
        process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD || "customfield_10429";

      payload.fields[acceptanceCriteriaField] =
        formatAcceptanceCriteria(acceptance_criteria);

      if (process.env.DEBUG === "true") {
        console.error(
          `[JIRA-MCP] Adding acceptance criteria to field ${acceptanceCriteriaField}`
        );
      }
    }

    // Only add custom fields for Bug, Task, and Story issue types. Do NOT add for Epic or Test.
    if (
      issue_type === "Bug" ||
      issue_type === "Task" ||
      issue_type === "Story"
    ) {
      const productField = process.env.JIRA_PRODUCT_FIELD;
      const productValue = process.env.JIRA_PRODUCT_VALUE;
      const productId = process.env.JIRA_PRODUCT_ID;

      if (productField && productValue && productId) {
        payload.fields[productField] = [{
          self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${productId}`,
          value: productValue,
          id: productId,
        }];
      } else if (productField && process.env.DEBUG === "true") {
        console.error(`[JIRA-MCP] Product field ${productField} is configured but missing JIRA_PRODUCT_VALUE or JIRA_PRODUCT_ID`);
      }

      const categoryField = process.env.JIRA_CATEGORY_FIELD;

      if (categoryField) {
        const useAlternateCategory =
          process.env.USE_ALTERNATE_CATEGORY === "true";

        const categoryOptionId = useAlternateCategory
          ? process.env.JIRA_ALTERNATE_CATEGORY_ID
          : process.env.JIRA_DEFAULT_CATEGORY_ID;

        const categoryOptionValue = useAlternateCategory
          ? process.env.JIRA_ALTERNATE_CATEGORY_VALUE
          : process.env.JIRA_DEFAULT_CATEGORY_VALUE;

        if (categoryOptionId && categoryOptionValue) {
          payload.fields[categoryField] = {
            self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${categoryOptionId}`,
            value: categoryOptionValue,
            id: categoryOptionId,
          };
        }
      }
    }

    if (story_points !== undefined && issue_type === "Story") {
      const storyPointsField =
        process.env.JIRA_STORY_POINTS_FIELD || "customfield_10040";
      payload.fields[storyPointsField] = story_points;
      payload.fields.labels = ["QA-Testable"];
    }

    if (parent_epic !== undefined) {
      if (issue_type === "Epic") {
        payload.fields.parent = { key: parent_epic };
      } else {
        const epicLinkField =
          process.env.JIRA_EPIC_LINK_FIELD || "customfield_10014";
        payload.fields[epicLinkField] = parent_epic;
      }
    }

    if (sprint !== undefined) {
      payload.fields["customfield_10020"] = [{ name: sprint }];
    }

    if (story_readiness !== undefined) {
      const storyReadinessId = story_readiness === "Yes" ? "18256" : "18257";
      payload.fields["customfield_10596"] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${storyReadinessId}`,
        value: story_readiness,
        id: storyReadinessId,
      };
    }

    if (crisis !== undefined) {
      const crisisField = process.env.JIRA_CRISIS_FIELD || "customfield_14238";
      const crisisId = crisis === "Yes"
        ? process.env.JIRA_CRISIS_YES_ID || "23123"
        : process.env.JIRA_CRISIS_NO_ID || "23124";

      payload.fields[crisisField] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${crisisId}`,
        value: crisis,
        id: crisisId,
      };
    }

    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await createJiraTicket(payload, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating ticket: ${result.errorMessage}`,
          },
        ],
      };
    }

    const ticketKey = result.data.key;
    let responseText = `Created ticket ${ticketKey} with summary: ${summary}, description: ${
      description || "No description"
    }, issue type: ${issue_type}`;

    if (acceptance_criteria !== undefined) {
      responseText += `, acceptance criteria: ${acceptance_criteria}`;
    }

    if (story_points !== undefined) {
      responseText += `, story points: ${story_points}`;
    }

    if (
      shouldCreateTestTicket &&
      issue_type === "Story" &&
      story_points !== undefined &&
      ticketKey
    ) {
      const testTicketPayload: any = {
        fields: {
          project: {
            key: process.env.JIRA_PROJECT_KEY || "SCRUM",
          },
          summary: `${ticketKey} ${summary}`,
          description: formatDescription(summary),
          issuetype: {
            name: "Test",
          },
        },
      };

      const testResult = await createJiraTicket(testTicketPayload, auth);

      if (testResult.success && testResult.data.key) {
        const linkResult = await createTicketLink(
          ticketKey,
          testResult.data.key,
          "Test Case Linking",
          auth
        );

        if (linkResult.success) {
          responseText += `\nCreated linked test ticket ${testResult.data.key}`;
        } else {
          responseText += `\nCreated test ticket ${testResult.data.key} but failed to link it: ${linkResult.errorMessage}`;
        }
      } else {
        responseText += `\nFailed to create test ticket: ${testResult.errorMessage}`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

server.tool(
  "link-tickets",
  "Link two jira tickets",
  {
    outward_issue: z.string().min(1, "Outward issue key is required"),
    inward_issue: z.string().min(1, "Inward issue key is required"),
    link_type: z
      .string()
      .min(1, "Link type is required")
      .default("Test Case Linking"),
  },
  async ({ outward_issue, inward_issue, link_type }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await createTicketLink(
      outward_issue,
      inward_issue,
      link_type,
      auth
    );

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error linking tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully linked ${outward_issue} to ${inward_issue} with link type "${link_type}"`,
        },
      ],
    };
  }
);

server.tool(
  "get-ticket",
  "Get a jira ticket",
  {
    ticket_id: z.string().min(1, "Ticket ID is required"),
  },
  async ({ ticket_id }) => {
    const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticket_id}`;
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    try {
      const response = await fetchWithRetry(jiraUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
      });

      const responseData = (await response.json()) as {
        id?: string;
        errorMessages?: string[];
        fields?: {
          project?: {
            id?: string;
          };
        };
      };

      if (!response.ok) {
        console.error("Error fetching ticket:", responseData);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching ticket: ${
                responseData.errorMessages?.join(", ") || "Unknown error"
              }`,
            },
          ],
        };
      }

      if (!responseData.fields) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No ticket fields found in response",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `JIRA Ticket: ${ticket_id}, Fields: ${JSON.stringify(
              responseData.fields,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Exception fetching ticket:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error fetching ticket: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

server.tool(
  "search-tickets",
  "Search for jira tickets by issue type",
  {
    issue_type: z.enum(["Bug", "Task", "Story", "Test", "Epic"]),
    max_results: z.number().min(1).max(50).default(10).optional(),
    additional_criteria: z.string().optional(),
  },
  async ({ issue_type, max_results = 10, additional_criteria }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    let jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND issuetype = "${issue_type}"`;

    if (additional_criteria) {
      jql += ` AND (${additional_criteria})`;
    }

    const result = await searchJiraTickets(jql, max_results, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    if (!result.data.issues || result.data.issues.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No ${issue_type} tickets found matching the criteria.`,
          },
        ],
      };
    }

    const tickets = result.data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.data.total} ${issue_type} tickets (showing ${
            tickets.length
          }):\n\n${JSON.stringify(tickets, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "search-tickets-jql",
  "Search for jira tickets using custom JQL query",
  {
    jql: z.string().min(1, "JQL query is required"),
    max_results: z.number().min(1).max(50).default(10).optional(),
    fields: z.string().optional().describe("Comma-separated list of fields to return (e.g. 'summary,status,issuetype'). Omit to get all fields."),
  },
  async ({ jql, max_results = 10, fields }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await searchJiraTickets(jql, max_results, auth, fields);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    if (!result.data.issues || result.data.issues.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No tickets found matching the JQL query: ${jql}`,
          },
        ],
      };
    }

    const tickets = result.data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
      issuetype: issue.fields.issuetype?.name || "Unknown",
      description: issue.fields.description || "No description",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.data.total || tickets.length} ticket(s) (showing ${
            tickets.length
          }):\n\n${JSON.stringify(tickets, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "update-ticket",
  "Update an existing jira ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    sprint: z.string().optional(),
    story_readiness: z.enum(["Yes", "No"]).optional(),
  },
  async ({ ticket_key, sprint, story_readiness }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const payload: any = {
      fields: {},
    };

    if (sprint !== undefined) {
      payload.fields["customfield_10020"] = [{ name: sprint }];
    }

    if (story_readiness !== undefined) {
      const storyReadinessId = story_readiness === "Yes" ? "18256" : "18257";
      payload.fields["customfield_10596"] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${storyReadinessId}`,
        value: story_readiness,
        id: storyReadinessId,
      };
    }

    if (Object.keys(payload.fields).length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: At least one field to update must be provided",
          },
        ],
      };
    }

    const result = await updateJiraTicket(ticket_key, payload, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating ticket: ${result.errorMessage}`,
          },
        ],
      };
    }

    let responseText = `Successfully updated ticket ${ticket_key}`;
    if (sprint !== undefined) {
      responseText += `, sprint: ${sprint}`;
    }
    if (story_readiness !== undefined) {
      responseText += `, story readiness: ${story_readiness}`;
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

server.tool(
  "add-comment",
  "Add a comment to a Jira ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    body: z.string().min(1, "Comment body is required"),
  },
  async ({ ticket_key, body }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");
    const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticket_key}/comment`;

    try {
      const response = await fetchWithRetry(jiraUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ body: markdownToAdf(body) }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as any;
        console.error("Error adding comment:", errorData);
        return {
          content: [
            {
              type: "text",
              text: `Error adding comment: Status ${response.status} ${response.statusText}`,
            },
          ],
        };
      }

      const data = (await response.json()) as any;
      return {
        content: [
          {
            type: "text",
            text: `Comment added successfully to ${ticket_key} (id: ${data.id})`,
          },
        ],
      };
    } catch (error) {
      console.error("Exception adding comment:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error adding comment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "edit-comment",
  "Edit an existing comment on a Jira ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    comment_id: z.string().min(1, "Comment ID is required"),
    body: z.string().min(1, "New comment body is required"),
  },
  async ({ ticket_key, comment_id, body }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");
    const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticket_key}/comment/${comment_id}`;

    try {
      const response = await fetchWithRetry(jiraUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ body: markdownToAdf(body) }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as any;
        console.error("Error editing comment:", errorData);
        return {
          content: [
            {
              type: "text",
              text: `Error editing comment: Status ${response.status} ${response.statusText}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Comment ${comment_id} on ${ticket_key} updated successfully`,
          },
        ],
      };
    } catch (error) {
      console.error("Exception editing comment:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error editing comment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "remove-issue-link",
  "Remove a link between two Jira tickets by link ID",
  {
    link_id: z.string().min(1, "Link ID is required"),
  },
  async ({ link_id }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");
    const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issueLink/${link_id}`;

    try {
      const response = await fetchWithRetry(jiraUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });

      if (!response.ok) {
        console.error("Error removing link: Status", response.status, response.statusText);
        return {
          content: [
            {
              type: "text",
              text: `Error removing link: Status ${response.status} ${response.statusText}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Link ${link_id} removed successfully`,
          },
        ],
      };
    } catch (error) {
      console.error("Exception removing link:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error removing link: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get-test-steps",
  "Get test steps from a test ticket via Zephyr integration",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
  },
  async ({ ticket_key }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const idResult = await getJiraIssueId(ticket_key, auth);

    if (!idResult.success || !idResult.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting internal ID for ticket ${ticket_key}: ${idResult.errorMessage}`,
          },
        ],
      };
    }

    const issueId = idResult.id;

    const projectId = idResult.projectId;
    if (!projectId) {
      console.error("Project ID not found, cannot get test steps");
      return {
        content: [
          {
            type: "text",
            text: `Error: Project ID not found for ticket ${ticket_key}`,
          },
        ],
      };
    }

    const result = await getZephyrTestSteps(issueId, projectId);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting test steps for ticket ${ticket_key}: ${result.errorMessage}`,
          },
        ],
      };
    }

    if (!result.steps || result.steps.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No test steps found for ticket ${ticket_key}.`,
          },
        ],
      };
    }

    const formattedSteps = result.steps.map((step) => ({
      id: step.id,
      orderId: step.orderId,
      step: step.step,
      data: step.data || "",
      result: step.result || "",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${
            formattedSteps.length
          } test step(s) for ticket ${ticket_key}:\n\n${JSON.stringify(
            formattedSteps,
            null,
            2
          )}`,
        },
      ],
    };
  }
);

server.tool(
  "add-test-steps",
  "Add test steps to a test ticket via Zephyr integration",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    steps: z
      .array(
        z.object({
          step: z.string().min(1, "Step description is required"),
          data: z.string().optional(),
          result: z.string().optional(),
        })
      )
      .min(1, "At least one test step is required"),
  },
  async ({ ticket_key, steps }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const idResult = await getJiraIssueId(ticket_key, auth);

    if (!idResult.success || !idResult.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting internal ID for ticket ${ticket_key}: ${idResult.errorMessage}`,
          },
        ],
      };
    }

    const issueId = idResult.id;

    const results: string[] = [];
    let allSuccessful = true;

    for (const [index, { step, data = "", result = "" }] of steps.entries()) {
      const projectId = idResult.projectId;
      if (!projectId) {
        console.error("Project ID not found, cannot add test steps");
        return {
          content: [
            {
              type: "text",
              text: `Error: Project ID not found for ticket ${ticket_key}`,
            },
          ],
        };
      }

      const stepResult = await addZephyrTestStep(
        issueId,
        projectId,
        step,
        data,
        result
      );

      if (stepResult.success) {
        results.push(`Step ${index + 1}: Added successfully`);
      } else {
        results.push(`Step ${index + 1}: Failed - ${stepResult.errorMessage}`);
        allSuccessful = false;
      }
    }

    if (allSuccessful) {
      return {
        content: [
          {
            type: "text",
            text: `Successfully added ${
              steps.length
            } test step(s) to ticket ${ticket_key}:\n\n${results.join("\n")}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `Some test steps could not be added to ticket ${ticket_key}:\n\n${results.join(
              "\n"
            )}`,
          },
        ],
      };
    }
  }
);

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Error in main():", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error running main:", error);
  process.exit(1);
});
