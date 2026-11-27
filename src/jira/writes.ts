import { OperationError } from "../http.js";
import { JiraClient } from "./api.js";

export type IssueFields = Record<string, unknown>;

export function setLegacyDefaults(fields: IssueFields) {
  const { JIRA_PRODUCT_VALUE: value, JIRA_PRODUCT_ID: id } = process.env;
  const product = process.env.JIRA_PRODUCT_FIELD?.trim();
  const category = process.env.JIRA_CATEGORY_FIELD?.trim();
  if (product && value && id) {
    fields[product] = [{ self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${id}`, value, id }];
  }
  const prefix = process.env.USE_ALTERNATE_CATEGORY === "true" ? "JIRA_ALTERNATE_CATEGORY" : "JIRA_DEFAULT_CATEGORY";
  const categoryId = process.env[`${prefix}_ID`];
  const categoryValue = process.env[`${prefix}_VALUE`];
  if (category && categoryId && categoryValue) {
    fields[category] = { self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${categoryId}`, value: categoryValue, id: categoryId };
  }
}

export async function createIssue(jira: JiraClient, fields: IssueFields, operation = "create ticket") {
  const send = async (payload: IssueFields) => {
    const result = await jira.post<{ key?: string }>(operation, "/rest/api/3/issue", { fields: payload });
    if (typeof result?.key !== "string" || !result.key) {
      throw new OperationError(`${operation}: Jira did not return a key; check whether the issue exists before retrying`,
        undefined, operation, [], {}, "uncertain");
    }
    return result.key;
  };
  const { JIRA_PRODUCT_VALUE: value, JIRA_PRODUCT_ID: id } = process.env;
  const product = process.env.JIRA_PRODUCT_FIELD?.trim();
  const category = process.env.JIRA_CATEGORY_FIELD?.trim();
  const payload = { ...fields };
  const omittedFields: string[] = [];
  const alternatives = id && value ? [id, [{ id }], [{ value }]] : [];
  let alternative = 0;
  while (true) {
    try {
      return { key: await send(payload), omittedFields };
    } catch (error) {
      if (!(error instanceof OperationError) || error.status !== 400) throw error;
      const productError = product && Object.hasOwn(payload, product) ? error.errors[product] : undefined;
      const categoryError = category && Object.hasOwn(payload, category) ? error.errors[category] : undefined;
      if (product && productError && alternative < alternatives.length) {
        payload[product] = alternatives[alternative++];
        continue;
      }
      const dropProduct = product && productError && !/required/i.test(productError);
      const dropCategory = category && categoryError && !/required/i.test(categoryError);
      if (!dropProduct && !dropCategory) throw error;
      if (dropProduct) {
        delete payload[product];
        omittedFields.push(product);
      }
      if (dropCategory) {
        delete payload[category];
        omittedFields.push(category);
      }
    }
  }
}

export function linkIssues(jira: JiraClient, outward: string, inward: string, type: string, operation = "link tickets") {
  return jira.command(operation, "/rest/api/3/issueLink", {
    outwardIssue: { key: outward }, inwardIssue: { key: inward }, type: { name: type },
  });
}

export async function getMyself(jira: JiraClient) {
  const result = await jira.get<{ accountId: string; displayName?: string }>("get current Jira user", "/rest/api/3/myself");
  if (!result?.accountId) throw new OperationError("get current Jira user: accountId is missing");
  return { accountId: result.accountId, displayName: result.displayName };
}

export async function resolveAssignee(jira: JiraClient, value: string) {
  const assignee = value.trim();
  if (!assignee) throw new OperationError("assignee must not be blank; use unassigned to remove the assignee");
  if (assignee === "me") return (await getMyself(jira)).accountId;
  return assignee === "unassigned" ? null : assignee;
}
