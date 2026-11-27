import { OperationError } from "../http.js";
import { allPages, issuePath, JiraClient, pathSegment, type JiraPage } from "./api.js";
import { formatJiraContent } from "./formatting.js";

type Field = { id: string; name: string };
type Option = { id?: string; value?: string; disabled?: boolean };
type FieldMetadata = { fieldId: string; allowedValues?: Option[] };
type Context = { ticketKey: string } | { projectKey: string; issueType: string };
type CustomValues = {
  story_points?: number;
  acceptance_criteria?: string;
  story_readiness?: "Yes" | "No";
  crisis?: "Yes" | "No";
};

const custom = {
  points: { env: "JIRA_STORY_POINTS_FIELD", name: "Story Points" },
  acceptance: { env: "JIRA_ACCEPTANCE_CRITERIA_FIELD", name: "Acceptance Criteria" },
  readiness: { env: "JIRA_STORY_READINESS_FIELD", name: "Story Readiness" },
  crisis: { env: "JIRA_CRISIS_FIELD", name: "Crisis" },
  sprint: { env: "JIRA_SPRINT_FIELD", name: "Sprint" },
};

const normalize = (name: string) => name.trim().toLowerCase();

export class FieldClaims {
  private readonly owners = new Map<string, string>();

  constructor() {
    const variables = [...Object.values(custom).map(({ env }) => env), "JIRA_PRODUCT_FIELD", "JIRA_CATEGORY_FIELD", "JIRA_EPIC_LINK_FIELD"];
    for (const variable of variables) {
      const id = process.env[variable]?.trim();
      if (id) this.claim(id, variable);
    }
  }

  claim(id: string, variable: string) {
    if (!/^customfield_\d+$/.test(id)) throw new OperationError(`${variable} must be a customfield_<id>`);
    const owner = this.owners.get(id);
    if (owner && owner !== variable) {
      throw new OperationError(`Custom field collision: ${owner} and ${variable} both resolve to ${id}`,
        undefined, undefined, [], { [id]: `${owner}, ${variable}` });
    }
    this.owners.set(id, variable);
    return id;
  }
}

export class JiraFields {
  private catalog?: { expires: number; fields: Promise<Field[]> };

  constructor(private readonly jira: JiraClient) {}

  private getCatalog() {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.fields;
    const fields = this.jira.get<Field[]>("discover Jira fields", "/rest/api/3/field").then((result) => {
      if (!Array.isArray(result)) throw new OperationError("discover Jira fields: expected a field list");
      return result;
    });
    this.catalog = { expires: Date.now() + 5 * 60_000, fields };
    void fields.catch(() => { if (this.catalog?.fields === fields) this.catalog = undefined; });
    return fields;
  }

  private async resolve(field: (typeof custom)[keyof typeof custom]): Promise<string>;
  private async resolve(field: (typeof custom)[keyof typeof custom], optional: true): Promise<string | undefined>;
  private async resolve(field: (typeof custom)[keyof typeof custom], optional?: boolean) {
    const configured = process.env[field.env]?.trim();
    if (configured) {
      if (!/^customfield_\d+$/.test(configured)) throw new OperationError(`${field.env} must be a customfield_<id>`);
      return configured;
    }
    const matches = (await this.getCatalog()).filter(({ id, name }) =>
      /^customfield_\d+$/.test(id) && typeof name === "string" && normalize(name) === normalize(field.name));
    if (matches.length === 1) return matches[0].id;
    if (optional && matches.length === 0) return undefined;
    throw new OperationError(`${field.name} field ${matches.length ? "is ambiguous" : "was not found"}; configure ${field.env}`);
  }

  sprintField() {
    return this.resolve(custom.sprint, true);
  }

  private async metadata(context: Context): Promise<Record<string, Pick<FieldMetadata, "allowedValues">>> {
    const operation = "read editable Jira fields";
    if ("ticketKey" in context) {
      const response = await this.jira.get<{ fields: Record<string, FieldMetadata> }>(operation, `${issuePath(context.ticketKey)}/editmeta`);
      return response?.fields ?? {};
    }
    const path = `/rest/api/3/issue/createmeta/${pathSegment(context.projectKey)}/issuetypes`;
    const types = await this.createMetadata<{ id: string; name: string }>(operation, path, "issueTypes");
    const matches = types.filter((type) => normalize(type.name) === normalize(context.issueType));
    if (matches.length !== 1) throw new OperationError(`${operation}: issue type is not uniquely available for creation`, undefined, operation);
    const fields = await this.createMetadata<FieldMetadata>(operation, `${path}/${pathSegment(matches[0].id)}`, "fields");
    return Object.fromEntries(fields.map((field) => [field.fieldId, field]));
  }

  private createMetadata<T>(operation: string, path: string, key: "issueTypes" | "fields") {
    return allPages<T>(operation, async (startAt) => {
      const page = await this.jira.get<JiraPage<T> & Partial<Record<typeof key, T[]>>>(operation, path, { startAt, maxResults: 50 });
      return { ...page, values: page?.[key] ?? page?.values };
    });
  }

  async forWrite(values: CustomValues, context: Context, claims: FieldClaims) {
    const fields: Record<string, unknown> = {};
    if (values.story_points !== undefined) {
      fields[claims.claim(await this.resolve(custom.points), custom.points.env)] = values.story_points;
    }
    if (values.acceptance_criteria !== undefined) {
      fields[claims.claim(await this.resolve(custom.acceptance), custom.acceptance.env)] =
        formatJiraContent(values.acceptance_criteria, "No acceptance criteria provided");
    }

    let metadata: ReturnType<JiraFields["metadata"]> | undefined;
    for (const key of ["readiness", "crisis"] as const) {
      const value = key === "readiness" ? values.story_readiness : values.crisis;
      if (value === undefined) continue;
      const field = custom[key];
      const id = claims.claim(await this.resolve(field), field.env);
      const variable = `${field.env.slice(0, -"_FIELD".length)}_${value.toUpperCase()}_ID`;
      const configured = process.env[variable]?.trim();
      const details = () => ({ [id]: `${field.name}: ${value}` });
      if (configured) {
        if (!/^\d+$/.test(configured)) throw new OperationError(`${variable} must be a numeric option ID`, undefined, undefined, [], details());
        fields[id] = { id: configured };
        continue;
      }

      const entry = (await (metadata ??= this.metadata(context)))[id];
      if (!entry) {
        throw new OperationError(`${field.name} is not editable in this issue context`, undefined, undefined, [], details());
      }
      const matches = (entry.allowedValues ?? []).filter((option) =>
        !option.disabled && option.id && typeof option.value === "string" && normalize(option.value) === normalize(value));
      if (matches.length !== 1) {
        throw new OperationError(`${field.name} option ${value} ${matches.length ? "is ambiguous" : "was not found"}; check ${variable}`, undefined, undefined, [], details());
      }
      fields[id] = { id: matches[0].id };
    }
    return fields;
  }
}
