import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const issue = '/rest/api/3/issue';
const ticket = `${issue}/DEMO-7`;
const own = '/rest/api/3/myself';
const search = '/rest/api/3/search/jql';
const catalog = '/rest/api/3/field';
const worklog = `${ticket}/worklog`;
const sprint = '/rest/agile/1.0/sprint/14/issue';
const board = '/rest/agile/1.0/board/8/sprint';
const compactFields = 'summary,issuetype,status,priority,assignee,reporter,parent,labels,created,updated,duedate,resolutiondate,description,timespent';
const commentsQuery = { orderBy: '-created', maxResults: '5' };
const worklogSummaryQuery = { startAt: '0', maxResults: '1' };
const token = 'TEST_ONLY_JIRA_SECRET';
const username = 'fixture@example.invalid';
const accessKey = 'TEST_ONLY_ZEPHYR_ACCESS';
const zephyrSecret = 'TEST_ONLY_ZEPHYR_SECRET';
const adf = (text, marks) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(marks && { marks }) }] }] });
const task = (extra = {}) => ({ fields: {
  project: { key: 'DEMO' }, summary: 'A task', description: adf('No description provided'), issuetype: { name: 'Task' }, ...extra,
} });

async function connect(t, fixtures = [], env = {}) {
  const client = new Client({ name: 'contract-tests', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', fileURLToPath(new URL('./mock-http.cjs', import.meta.url)), fileURLToPath(new URL('../build/index.js', import.meta.url))],
    stderr: 'pipe',
    env: {
      JIRA_HOST: 'jira.example.invalid', JIRA_USERNAME: username, JIRA_API_TOKEN: token, JIRA_PROJECT_KEY: 'DEMO',
      JIRA_PRODUCT_FIELD: '', JIRA_CATEGORY_FIELD: '', JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: '', JIRA_SPRINT_BOARD_ID: '', JIRA_SPRINT_FIELD: '',
      JIRA_EPIC_LINK_FIELD: '', JIRA_PRODUCT_ID: '', JIRA_PRODUCT_VALUE: '', JIRA_DEFAULT_CATEGORY_ID: '', JIRA_DEFAULT_CATEGORY_VALUE: '', USE_ALTERNATE_CATEGORY: 'false',
      JIRA_STORY_POINTS_FIELD: '', JIRA_ACCEPTANCE_CRITERIA_FIELD: '', JIRA_STORY_READINESS_FIELD: '', JIRA_CRISIS_FIELD: '',
      JIRA_STORY_READINESS_YES_ID: '', JIRA_STORY_READINESS_NO_ID: '', JIRA_CRISIS_YES_ID: '', JIRA_CRISIS_NO_ID: '',
      AUTO_CREATE_TEST_TICKETS: 'false', DEBUG: 'true', ZAPI_BASE_URL: 'https://zephyr.example.invalid/connect',
      ZAPI_ACCOUNT_ID: '', ZAPI_ACCESS_KEY: accessKey, ZAPI_SECRET_KEY: zephyrSecret,
      ...env, TEST_HTTP_FIXTURES: JSON.stringify(fixtures),
    },
  });
  let stderr = '';
  await client.connect(transport);
  const stream = transport.stderr;
  stream.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    const closed = finished(stream);
    await client.close();
    await closed;
    assert.deepEqual(stderr.trim().split('\n').filter(Boolean), fixtures.map((_, i) => `Matched HTTP fixture ${i + 1}`));
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const read = async (name, args, error = false) => {
    const response = await call(name, args);
    assert.equal(Boolean(response.isError), error, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  return { client, call, read };
}

const writeStates = (response) => Object.fromEntries(Object.entries(response.steps).map(([name, step]) => [name, step.state]));

test('the compiled stdio entrypoint exposes one catalogue and preserves historical schemas', async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const historic = {
    'create-ticket': ['summary issue_type description acceptance_criteria story_points create_test_ticket parent_epic sprint story_readiness project_key crisis', 'summary'],
    'get-ticket': ['ticket_id', 'ticket_id'],
    'update-ticket': ['ticket_key summary description sprint story_readiness', 'ticket_key'],
    'search-tickets': ['issue_type max_results additional_criteria', 'issue_type'],
    'search-tickets-jql': ['jql max_results fields', 'jql'],
    'link-tickets': ['outward_issue inward_issue link_type', 'outward_issue inward_issue'],
    'remove-issue-link': ['link_id', 'link_id'],
    'add-comment': ['ticket_key body', 'ticket_key body'],
    'edit-comment': ['ticket_key comment_id body', 'ticket_key comment_id body'],
    'delete-comment': ['ticket_key comment_id', 'ticket_key comment_id'],
    'get-test-steps': ['ticket_key', 'ticket_key'],
    'add-test-steps': ['ticket_key steps', 'ticket_key steps'],
  };
  assert.deepEqual(tools.map(({ name }) => name).sort(), [...Object.keys(historic), 'transition-ticket', 'assign-ticket', 'add-worklog',
    'get-sprints', 'move-ticket-to-sprint', 'get-myself', 'list-worklogs'].sort());
  for (const [name, [keys, required]] of Object.entries(historic)) {
    const schema = tools.find((tool) => tool.name === name).inputSchema;
    for (const key of keys.split(' ')) assert.ok(schema.properties[key], `${name}.${key}`);
    assert.deepEqual(schema.required.sort(), required.split(' ').sort());
  }
  assert.equal(tools.find(({ name }) => name === 'create-ticket').inputSchema.properties.issue_type.default, 'Task');
  assert.equal(tools.find(({ name }) => name === 'link-tickets').inputSchema.properties.link_type.default, 'Test Case Linking');
  assert.deepEqual(Object.keys(tools.find(({ name }) => name === 'add-comment').inputSchema.properties).sort(), ['body', 'ticket_key']);
});

test('creates once without the Sprint field and returns the key when the Agile write fails', async (t) => {
  const { read } = await connect(t, [
    { path: issue, method: 'POST', body: task(), json: { key: 'DEMO-7' }, status: 201 },
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 403, json: { errors: { issues: 'Missing permission' } } },
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 204 },
  ], { JIRA_SPRINT_FIELD: 'customfield_10016' });
  const result = await read('create-ticket', { summary: 'A task', sprint_id: 14 }, true);
  assert.equal(result.ticket_key, 'DEMO-7');
  assert.equal(result.sprint_id, 14);
  assert.deepEqual(writeStates(result), { create_ticket: 'done', move_to_sprint: 'rejected', create_test_ticket: 'not_attempted', link_test_ticket: 'not_attempted' });
  assert.equal(result.steps.move_to_sprint.status, 403);
  assert.deepEqual(result.steps.move_to_sprint.errors, { issues: 'Missing permission' });
  assert.match(result.steps.move_to_sprint.recovery, /move-ticket-to-sprint/);
  assert.deepEqual(await read('move-ticket-to-sprint', { ticket_key: 'DEMO-7', sprint_id: 14 }), { ticket_key: 'DEMO-7', sprint_id: 14, moved: true });
});

test('resolves sprint names over all board pages and moves only after updating the issue', async (t) => {
  const { read } = await connect(t, [
    { path: board, query: { startAt: '0', maxResults: '50' }, json: { startAt: 0, isLast: false, values: [{ id: 13, name: 'Earlier', state: 'closed' }] } },
    { path: board, query: { startAt: '1', maxResults: '50' }, json: { startAt: 1, isLast: true, values: [{ id: 14, name: 'Next Sprint', state: 'future' }] } },
    { path: ticket, method: 'PUT', body: { fields: { summary: 'New summary' } }, status: 204 },
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 204 },
    { path: board, query: { state: 'active', startAt: '0', maxResults: '50' }, json: { isLast: true, values: [{ id: 15, name: 'Now', state: 'active' }] } },
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 204 },
  ], { JIRA_SPRINT_BOARD_ID: '8' });
  const update = await read('update-ticket', { ticket_key: 'DEMO-7', summary: 'New summary', sprint: 'next sprint' });
  assert.equal(update.sprint_id, 14);
  assert.deepEqual(writeStates(update), { update_ticket: 'done', move_to_sprint: 'done' });
  assert.deepEqual(await read('get-sprints', { board_id: 8 }), { board_id: 8, state: 'active', sprints: [{ id: 15, name: 'Now', state: 'active' }] });
  assert.deepEqual(writeStates(await read('update-ticket', { ticket_key: 'DEMO-7', sprint_id: 14 })), { update_ticket: 'not_attempted', move_to_sprint: 'done' });
});

test('rejects an ambiguous sprint name before any issue write', async (t) => {
  const { read } = await connect(t, [{ path: board, query: { startAt: '0', maxResults: '50' }, json: {
    isLast: true, values: [{ id: 13, name: 'Sprint X', state: 'closed' }, { id: 14, name: 'Sprint X', state: 'active' }],
  } }], { JIRA_SPRINT_BOARD_ID: '8' });
  const failed = await read('create-ticket', { summary: 'A task', sprint: 'Sprint X' }, true);
  assert.match(failed.steps.create_ticket.error, /ambiguous/);
  assert.equal(failed.steps.create_ticket.state, 'not_attempted');
  assert.equal(failed.steps.move_to_sprint.state, 'not_attempted');
});

test('lists transitions by default, rejects ambiguity and posts an ADF comment with the selected transition', async (t) => {
  const path = `${ticket}/transitions`;
  const query = { expand: 'transitions.fields' };
  const transitions = [
    { id: '11', name: 'Finish', to: { name: 'Done' }, fields: { resolution: { required: true } } },
    { id: '12', name: 'FINISH', to: { name: 'Rejected' } },
    { id: '13', name: 'Review', to: { name: 'In review' } },
  ];
  const list = { path, query, json: { transitions } };
  const { read } = await connect(t, [list, list, list, list,
    { path, method: 'POST', body: { transition: { id: '13' }, update: { comment: [{ add: { body: adf('Ready') } }] } }, status: 204 },
    { path: ticket, query: { fields: 'status' }, json: { fields: { status: { name: 'Verified by workflow' } } } },
    list, { path, method: 'POST', body: { transition: { id: '12' } }, status: 204 },
    { path: ticket, query: { fields: 'status' }, status: 403 },
  ]);
  const args = { ticket_key: 'DEMO-7' };
  const listing = await read('transition-ticket', args);
  assert.deepEqual(listing.transitions[0], { id: '11', name: 'Finish', to: 'Done', required_fields: ['resolution'] });
  assert.match((await read('transition-ticket', { ...args, transition_name: 'finish' }, true)).error, /ambiguous/);
  assert.match((await read('transition-ticket', { ...args, transition_id: '13', transition_name: 'finish' }, true)).error, /do not identify the same/);
  assert.equal((await read('transition-ticket', { ...args, transition_name: 'review', comment: 'Ready' })).status, 'Verified by workflow');
  const partial = await read('transition-ticket', { ...args, transition_id: '12', transition_name: 'finish' }, true);
  assert.equal(partial.transition.state, 'done');
  assert.equal(partial.status, 403);
  assert.match(partial.recovery, /do not repeat/);
});

test('get-myself, me, explicit unassignment and the configured assignee default', async (t) => {
  const myself = { path: own, json: { accountId: 'user-a', displayName: 'User A', emailAddress: 'omit' } };
  const assign = (accountId) => ({ path: `${ticket}/assignee`, method: 'PUT', body: { accountId }, status: 204 });
  const create = (accountId) => ({ path: issue, method: 'POST', body: task({ assignee: { accountId } }), json: { key: 'DEMO-7' }, status: 201 });
  const { call, read } = await connect(t, [myself, myself, assign('user-a'), assign(null), assign('user-b'), create('user-default'), myself, create('user-a'), create(null)], {
    JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'user-default',
  });
  assert.deepEqual(await read('get-myself'), { accountId: 'user-a', displayName: 'User A' });
  for (const [assignee, accountId] of [['me', 'user-a'], ['unassigned', null], ['user-b', 'user-b']]) {
    assert.equal((await read('assign-ticket', { ticket_key: 'DEMO-7', assignee })).accountId, accountId);
  }
  assert.match((await read('assign-ticket', { ticket_key: 'DEMO-7', assignee: ' ' }, true)).error, /blank/);
  for (const assignee of [undefined, 'me', 'unassigned']) {
    assert.match((await call('create-ticket', { summary: 'A task', assignee })).content[0].text, /Created ticket DEMO-7/);
  }
});

test('discovers fields by name, caches the catalogue and uses issue-specific select options', async (t) => {
  const path = `${issue}/createmeta/DEMO/issuetypes`;
  const query = { startAt: '0', maxResults: '50' };
  const { call } = await connect(t, [
    { path: catalog, json: [
      { id: 'customfield_1', name: 'sToRy PoInTs' }, { id: 'customfield_2', name: 'Acceptance Criteria' },
      { id: 'customfield_3', name: 'Story Readiness' }, { id: 'customfield_4', name: 'Crisis' },
    ] },
    { path, query, json: { startAt: 0, total: 1, issueTypes: [{ id: '100', name: 'Story' }] } },
    { path: `${path}/100`, query, json: { total: 2, fields: [
      { fieldId: 'customfield_3', allowedValues: [{ id: '11', value: 'yes' }, { id: '12', value: 'Yes', disabled: true }] },
      { fieldId: 'customfield_4', allowedValues: [{ id: '13', value: 'No' }] },
    ] } },
    { path: issue, method: 'POST', status: 201, json: { key: 'DEMO-7' }, body: task({
      issuetype: { name: 'Story' }, labels: ['QA-Testable'], customfield_1: 0, customfield_2: adf('Criteria'),
      customfield_3: { id: '11' }, customfield_4: { id: '13' },
    }) },
    { path: `${ticket}/editmeta`, json: { fields: { customfield_3: { allowedValues: [{ id: '21', value: 'Yes' }] } } } },
    { path: ticket, method: 'PUT', status: 204, body: { fields: { customfield_1: 8, customfield_3: { id: '21' } } } },
  ]);
  const create = await call('create-ticket', { summary: 'A task', issue_type: 'Story', story_points: 0,
    acceptance_criteria: 'Criteria', story_readiness: 'Yes', crisis: 'No' });
  assert.match(create.content[0].text, /Created ticket DEMO-7/);
  const update = await call('update-ticket', { ticket_key: 'DEMO-7', story_points: 8, story_readiness: 'Yes' });
  assert.match(update.content[0].text, /Successfully updated/);
});

test('explicit field and option overrides take precedence; missing and ambiguous discovered fields fail', async (t) => {
  const { call, read } = await connect(t, [
    { path: ticket, method: 'PUT', body: { fields: { customfield_91: { id: '7' } } }, status: 204 },
    { path: catalog, json: [{ id: 'customfield_1', name: 'Story Points' }, { id: 'customfield_2', name: 'story points' }] },
  ], { JIRA_STORY_READINESS_FIELD: 'customfield_91', JIRA_STORY_READINESS_NO_ID: '7' });
  assert.match((await call('update-ticket', { ticket_key: 'DEMO-7', story_readiness: 'No' })).content[0].text, /Successfully updated/);
  assert.match((await read('create-ticket', { summary: 'A task', story_points: 1 }, true)).steps.create_ticket.error, /ambiguous.*JIRA_STORY_POINTS_FIELD/);
  assert.match((await read('create-ticket', { summary: 'A task', crisis: 'No' }, true)).steps.create_ticket.error, /not found.*JIRA_CRISIS_FIELD/);
});

test('rejects field ID collisions before writes, including collisions with discovered fields', async (t) => {
  await t.test('two configured variables', async (t) => {
    const { read } = await connect(t, [], { JIRA_PRODUCT_FIELD: 'customfield_34', JIRA_STORY_POINTS_FIELD: ' customfield_34 ' });
    const created = await read('create-ticket', { summary: 'A task', sprint_id: 14 }, true);
    assert.equal(created.steps.create_ticket.state, 'not_attempted');
    assert.match(created.steps.create_ticket.error, /collision.*customfield_34/);
    const updated = await read('update-ticket', { ticket_key: 'DEMO-7', summary: 'A task', sprint_id: 14 }, true);
    assert.match(updated.errors.customfield_34, /JIRA_STORY_POINTS_FIELD.*JIRA_PRODUCT_FIELD/);
    assert.deepEqual(writeStates(updated), { update_ticket: 'not_attempted', move_to_sprint: 'not_attempted' });
  });
  await t.test('discovered Story Points and a configured Category', async (t) => {
    const { read } = await connect(t, [{ path: catalog, json: [{ id: 'customfield_34', name: 'Story Points' }] }], { JIRA_CATEGORY_FIELD: 'customfield_34' });
    const failed = await read('create-ticket', { summary: 'A task', story_points: 3 }, true);
    assert.match(failed.steps.create_ticket.errors.customfield_34, /JIRA_CATEGORY_FIELD.*JIRA_STORY_POINTS_FIELD/);
  });
});

test('reports optional Product and Category fields dropped after Jira validation failures', async (t) => {
  const post = (fields, status, json) => ({ path: issue, method: 'POST', body: task(fields), status, json });
  const rejected = { errors: { customfield_51: 'Not available on this screen', customfield_52: 'Invalid category' } };
  const option = (id, value) => ({ id, value, self: `https://jira.example.invalid/rest/api/3/customFieldOption/${id}` });
  const category = option('12', 'Web');
  const attempts = [[option('11', 'News')], '11', [{ id: '11' }], [{ value: 'News' }]].map((product) =>
    post({ customfield_51: product, customfield_52: category }, 400, rejected));
  const retry = post({}, 201, { key: 'DEMO-7' });
  const { call, read } = await connect(t, [...attempts, retry, ...attempts, retry,
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 204 },
  ], {
    JIRA_PRODUCT_FIELD: 'customfield_51', JIRA_PRODUCT_ID: '11', JIRA_PRODUCT_VALUE: 'News',
    JIRA_CATEGORY_FIELD: 'customfield_52', JIRA_DEFAULT_CATEGORY_ID: '12', JIRA_DEFAULT_CATEGORY_VALUE: 'Web',
  });
  const text = await call('create-ticket', { summary: 'A task' });
  assert.ok(!text.isError);
  assert.match(text.content[0].text, /omitted: customfield_51, customfield_52/);
  const json = await read('create-ticket', { summary: 'A task', sprint_id: 14 });
  assert.deepEqual(json.steps.create_ticket.omitted_fields, ['customfield_51', 'customfield_52']);
});

test('returns compact ticket details, latest comments and worklog totals, with raw output as an escape hatch', async (t) => {
  const description = { type: 'doc', version: 1, content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Details' }] },
    ...adf('Link', [{ type: 'link', attrs: { href: 'https://example.invalid' } }]).content,
  ] };
  const fields = {
    summary: 'A task', issuetype: { name: 'Task' }, status: { name: 'Open' }, priority: { name: 'Medium' },
    assignee: null, reporter: { accountId: 'user-a', displayName: 'User A', avatarUrls: {} },
    parent: { key: 'DEMO-2', fields: { summary: 'Parent', status: { name: 'Open' } } },
    created: '2026-04-10', updated: '2026-04-11', duedate: null, labels: ['tag'], description,
    customfield_10016: [{ id: 14, name: 'Next', state: 'active', goal: 'Extra' }], customfield_10020: 'omit',
    timespent: 2400, worklog: { total: 3, worklogs: [{ id: '88' }] },
  };
  const { call, read } = await connect(t, [
    { path: catalog, json: [{ id: 'customfield_10016', name: 'Sprint' }] },
    { path: ticket, query: { fields: `${compactFields},customfield_10016` }, json: { key: 'DEMO-7', fields } },
    { path: `${ticket}/comment`, query: commentsQuery, json: { total: 10,
      comments: Array.from({ length: 6 }, (_, i) => ({ id: String(10 - i), body: adf(i === 0 ? 'a'.repeat(1_100) : 'hello') })),
    } },
    { path: worklog, query: worklogSummaryQuery, json: { total: 3, worklogs: [{ id: '88' }] } },
    { path: ticket, json: { key: 'DEMO-7', fields } },
  ]);
  const compact = await read('get-ticket', { ticket_id: 'DEMO-7' });
  assert.equal(compact.key, 'DEMO-7');
  assert.equal(compact.assignee, null);
  assert.deepEqual(compact.reporter, { accountId: 'user-a', displayName: 'User A' });
  assert.deepEqual(compact.parent, { key: 'DEMO-2', summary: 'Parent' });
  assert.deepEqual(compact.sprint, [{ id: 14, name: 'Next', state: 'active' }]);
  assert.equal(compact.description, '## Details\n\n[Link](https://example.invalid)');
  assert.deepEqual(compact.comments.map(({ id }) => id), ['10', '9', '8', '7', '6']);
  assert.equal(compact.comments[0].body.length, 1001);
  assert.deepEqual(compact.worklogs, { total: 3, timeSpentSeconds: 2400 });
  assert.equal(compact.customfield_10020, undefined);
  const raw = await call('get-ticket', { ticket_id: 'DEMO-7', raw: true });
  assert.deepEqual(JSON.parse(raw.content[0].text.split('Fields: ')[1]), fields);
});

test('compact ticket reads keep the issue and warn separately when optional sections fail', async (t) => {
  await t.test('sprint discovery and both ancillary reads fail', async (t) => {
    const { read } = await connect(t, [
      { path: catalog, status: 403 },
      { path: ticket, query: { fields: compactFields }, json: { key: 'DEMO-7', fields: { summary: 'Still readable', timespent: 3600 } } },
      { path: `${ticket}/comment`, query: commentsQuery, status: 403 },
      { path: worklog, query: worklogSummaryQuery, status: 503 },
    ]);
    const compact = await read('get-ticket', { ticket_id: 'DEMO-7' });
    assert.equal(compact.summary, 'Still readable');
    assert.equal(compact.sprint, undefined);
    assert.equal(compact.comments, undefined);
    assert.deepEqual(compact.worklogs, { timeSpentSeconds: 3600 });
    assert.deepEqual(Object.fromEntries(Object.entries(compact.warnings).map(([part, warning]) => [part, warning.status])),
      { sprint: 403, comments: 403, worklogs: 503 });
  });
  await t.test('configured sprint projection is rejected', async (t) => {
    const { read } = await connect(t, [
      { path: ticket, query: { fields: `${compactFields},customfield_99` }, status: 400, json: { errors: { customfield_99: 'Unavailable' } } },
      { path: ticket, query: { fields: compactFields }, json: { key: 'DEMO-7', fields: { summary: 'Still readable' } } },
      { path: `${ticket}/comment`, query: commentsQuery, json: { comments: [] } },
      { path: worklog, query: worklogSummaryQuery, json: { total: 0 } },
    ], { JIRA_SPRINT_FIELD: 'customfield_99' });
    const compact = await read('get-ticket', { ticket_id: 'DEMO-7' });
    assert.equal(compact.summary, 'Still readable');
    assert.deepEqual(compact.comments, []);
    assert.deepEqual(compact.worklogs, { total: 0 });
    assert.deepEqual(Object.keys(compact.warnings), ['sprint']);
  });
});

test('JQL search preserves nulls and requested fields and continues after an empty page', async (t) => {
  const fields = 'summary,assignee,parent,updated,description,customfield_21';
  const jql = 'project = DEMO';
  const args = { jql, fields };
  const query = { fields, jql, maxResults: '10' };
  const { read } = await connect(t, [
    { path: search, query, json: { issues: [], nextPageToken: 'X&Y=A', isLast: false } },
    { path: search, query: { ...query, nextPageToken: 'X&Y=A' }, json: { issues: [{ key: 'DEMO-7', fields: {
      summary: 'A task', assignee: null, parent: { key: 'DEMO-1' }, updated: 'today', customfield_21: 4, status: { name: 'Open' },
    } }], isLast: true } },
    { path: search, query: { jql: 'project = "DEMO" AND issuetype = "Task"', fields: 'summary,status,priority', maxResults: '10' },
      json: { issues: [{ key: 'DEMO-7', fields: { summary: 'A task' } }] } },
  ]);
  assert.deepEqual(await read('search-tickets-jql', args), { tickets: [], count: 0, next_page_token: 'X&Y=A', is_last: false });
  assert.deepEqual(await read('search-tickets-jql', { ...args, next_page_token: 'X&Y=A' }), {
    count: 1, is_last: true, tickets: [{ key: 'DEMO-7', summary: 'A task', assignee: null, parent: { key: 'DEMO-1' }, updated: 'today', customfield_21: 4 }],
  });
  assert.deepEqual(await read('search-tickets', { issue_type: 'Task' }), { count: 1, tickets: [{ key: 'DEMO-7', summary: 'A task' }] });
});

test('worklogs accept either duration format and use Jira-confirmed data across pages', async (t) => {
  const started = '2026-04-02T06:10:00.000+0000';
  const work = { id: '9001', started, timeSpentSeconds: 2400, timeSpent: '40m' };
  const comment = adf('Investigation', [{ type: 'strong' }]);
  const { client, read } = await connect(t, [
    { path: worklog, method: 'POST', body: { timeSpentSeconds: 2400, started, comment }, json: work, status: 201 },
    { path: worklog, method: 'POST', body: { timeSpent: '1h' }, json: { ...work, id: '9002', timeSpentSeconds: 3600, timeSpent: '1h' }, status: 201 },
    { path: worklog, query: { startAt: '0', maxResults: '1' }, json: { startAt: 0, maxResults: 1, total: 2,
      worklogs: [{ ...work, comment, author: { accountId: 'a', displayName: 'A', avatarUrls: {} } }],
    } },
    { path: worklog, query: { startAt: '1', maxResults: '1' }, json: { startAt: 1, maxResults: 1, total: 2, worklogs: [{ ...work, id: '9002' }] } },
  ]);
  const args = { ticket_key: 'DEMO-7' };
  assert.match((await read('add-worklog', args, true)).error, /exactly one/);
  assert.match((await read('add-worklog', { ...args, time_spent: '1h', time_spent_seconds: 1 }, true)).error, /exactly one/);
  const noTimezone = () => client.callTool({ name: 'add-worklog', arguments: { ...args, time_spent: '1h', started: '2026-04-02T08:10:00' } });
  const rejected = await noTimezone().catch((error) => error);
  assert.ok(rejected instanceof Error || rejected.isError);
  assert.deepEqual(await read('add-worklog', { ...args, time_spent_seconds: 2400, started: '2026-04-02T08:10:00+02:00', comment: '**Investigation**' }), { ...args, ...work });
  assert.equal((await read('add-worklog', { ...args, time_spent: '1h' })).timeSpentSeconds, 3600);
  const page = await read('list-worklogs', { ...args, max_results: 1 });
  assert.equal(page.next_start_at, 1);
  assert.deepEqual(page.worklogs, [{ ...work, comment: '**Investigation**', author: { accountId: 'a', displayName: 'A' } }]);
  const last = await read('list-worklogs', { ...args, start_at: 1, max_results: 1 });
  assert.equal(last.next_start_at, undefined);
  assert.equal(last.worklogs[0].id, '9002');
});

test('historical comment, link and Zephyr tools reach the original endpoints', async (t) => {
  const zephyr = { origin: 'https://zephyr.example.invalid', path: '/connect/public/rest/api/1.0/teststep/17', query: { projectId: '99' } };
  const ids = { path: ticket, query: { fields: 'project' }, json: { id: '17', fields: { project: { id: '99' } } } };
  const { call } = await connect(t, [
    { path: `${ticket}/comment`, method: 'POST', body: { body: adf('Hi') }, json: { id: '22' }, status: 201 },
    { path: `${ticket}/comment/22`, method: 'PUT', body: { body: adf('Updated') }, status: 204 },
    { path: `${ticket}/comment/22`, method: 'DELETE', status: 204 },
    { path: '/rest/api/3/issueLink', method: 'POST', body: { outwardIssue: { key: 'DEMO-7' }, inwardIssue: { key: 'DEMO-8' }, type: { name: 'Test Case Linking' } }, status: 201 },
    { path: '/rest/api/3/issueLink/35', method: 'DELETE', status: 204 },
    ids, { ...zephyr, json: [{ id: 1, orderId: 1, step: 'Verify' }] },
    ids, { ...zephyr, method: 'POST', body: { projectId: '99', step: 'Confirm', data: '', result: '' }, json: { id: 2 }, status: 201 },
  ]);
  const args = { ticket_key: 'DEMO-7' };
  for (const [name, params] of [
    ['add-comment', { ...args, body: 'Hi' }], ['edit-comment', { ...args, comment_id: '22', body: 'Updated' }],
    ['delete-comment', { ...args, comment_id: '22' }], ['link-tickets', { outward_issue: 'DEMO-7', inward_issue: 'DEMO-8' }],
    ['remove-issue-link', { link_id: '35' }],
  ]) assert.ok(!(await call(name, params)).isError);
  assert.match((await call('get-test-steps', args)).content[0].text, /"step": "Verify"/);
  const added = await call('add-test-steps', { ...args, steps: [{ step: 'Confirm' }] });
  assert.ok(!added.isError);
  assert.equal(added.content[0].text, 'Successfully added 1 test step(s) to ticket DEMO-7:\n\nStep 1: Added successfully');
  assert.deepEqual(JSON.parse(added.content[1].text), { ticket_key: 'DEMO-7', steps: [{ step: 1, state: 'done' }] });
});

test('an uncertain Agile write does not block the linked Test; recovery moves only the Story', async (t) => {
  const story = { path: issue, method: 'POST', status: 201, json: { key: 'DEMO-7' }, body: task({
    issuetype: { name: 'Story' }, labels: ['QA-Testable'], customfield_34: 3,
  }) };
  const testIssue = { path: issue, method: 'POST', status: 201, json: { key: 'DEMO-8' }, body: { fields: {
    project: { key: 'DEMO' }, summary: 'DEMO-7 A task', description: adf('A task'), issuetype: { name: 'Test' },
  } } };
  const link = { path: '/rest/api/3/issueLink', method: 'POST', body: {
    outwardIssue: { key: 'DEMO-7' }, inwardIssue: { key: 'DEMO-8' }, type: { name: 'Test Case Linking' },
  } };
  const move = { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] } };
  const { call, read } = await connect(t, [
    story, { ...move, networkFailure: true }, testIssue, { ...link, status: 204 },
    { path: ticket, query: {}, json: { key: 'DEMO-7', fields: { customfield_10016: [] } } },
    { ...move, status: 204 }, story, testIssue, { ...link, status: 503 },
    story, { ...testIssue, status: 201, json: {} },
  ], {
    AUTO_CREATE_TEST_TICKETS: 'true', JIRA_STORY_POINTS_FIELD: 'customfield_34',
  });
  const payload = { summary: 'A task', issue_type: 'Story', story_points: 3 };
  const partial = await read('create-ticket', { ...payload, sprint_id: 14 }, true);
  assert.equal(partial.ticket_key, 'DEMO-7');
  assert.equal(partial.test_ticket_key, 'DEMO-8');
  assert.deepEqual(writeStates(partial), { create_ticket: 'done', move_to_sprint: 'uncertain', create_test_ticket: 'done', link_test_ticket: 'done' });
  assert.match(partial.steps.move_to_sprint.recovery, /check.*get-ticket.*before retrying/i);
  const check = await call('get-ticket', { ticket_id: partial.ticket_key, raw: true });
  assert.deepEqual(JSON.parse(check.content[0].text.split('Fields: ')[1]).customfield_10016, []);
  const recovered = await read('move-ticket-to-sprint', { ticket_key: partial.ticket_key, sprint_id: partial.sprint_id });
  assert.equal(recovered.moved, true);
  const error = await read('create-ticket', payload, true);
  assert.equal(error.ticket_key, 'DEMO-7');
  assert.equal(error.test_ticket_key, 'DEMO-8');
  assert.equal(error.steps.link_test_ticket.state, 'uncertain');
  assert.equal(error.steps.link_test_ticket.status, 503);
  assert.match(error.steps.link_test_ticket.recovery, /Check issue links/);
  const unknownTest = await read('create-ticket', payload, true);
  assert.equal(unknownTest.ticket_key, 'DEMO-7');
  assert.equal(unknownTest.test_ticket_key, undefined);
  assert.equal(unknownTest.test_project_key, 'DEMO');
  assert.equal(unknownTest.steps.create_test_ticket.state, 'uncertain');
  assert.match(unknownTest.steps.create_test_ticket.recovery, /confirmed absent/);
  assert.equal(unknownTest.steps.link_test_ticket.state, 'not_attempted');
});

test('Zephyr partial errors contain no JWT, access key or secret key', async (t) => {
  const { call } = await connect(t, [
    { path: ticket, query: { fields: 'project' }, json: { id: '17', fields: { project: { id: '99' } } } },
    { origin: 'https://zephyr.example.invalid', path: '/connect/public/rest/api/1.0/teststep/17', query: { projectId: '99' },
      method: 'POST', body: { projectId: '99', step: 'Confirm', data: '', result: '' }, status: 401, echoSecrets: true },
  ]);
  const response = await call('add-test-steps', { ticket_key: 'DEMO-7', steps: [{ step: 'Confirm' }] });
  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, 'Some test steps could not be added to ticket DEMO-7:\n\nStep 1: Failed - Status: 401 Unauthorized');
  const data = JSON.parse(response.content[1].text);
  assert.equal(data.steps[0].status, 401);
  assert.equal(data.steps[0].state, 'rejected');
  assert.match(data.steps[0].errorMessages[0], /REDACTED/);
  assert.doesNotMatch(JSON.stringify(response), /eyJ|TEST_ONLY_ZEPHYR_|RAW_RESPONSE_SENTINEL/);
});

test('Zephyr stops after a 5xx without resending the uncertain step or attempting later steps', async (t) => {
  const zephyr = { origin: 'https://zephyr.example.invalid', path: '/connect/public/rest/api/1.0/teststep/17', query: { projectId: '99' }, method: 'POST' };
  const { call } = await connect(t, [
    { path: ticket, query: { fields: 'project' }, json: { id: '17', fields: { project: { id: '99' } } } },
    { ...zephyr, body: { projectId: '99', step: 'First', data: '', result: '' }, status: 201 },
    { ...zephyr, body: { projectId: '99', step: 'Second', data: '', result: '' }, status: 502 },
  ]);
  const response = await call('add-test-steps', { ticket_key: 'DEMO-7', steps: ['First', 'Second', 'Third'].map((step) => ({ step })) });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Step 1: Added successfully\nStep 2: Outcome uncertain.*\nStep 3: Not attempted/);
  const data = JSON.parse(response.content[1].text);
  assert.equal(data.ticket_key, 'DEMO-7');
  assert.deepEqual(data.steps.map(({ state }) => state), ['done', 'uncertain', 'not_attempted']);
  assert.equal(data.steps[1].status, 502);
  assert.match(data.steps[1].recovery, /get-test-steps.*before retrying/);
});

test('an unresolved primary write leaves dependent steps not attempted', async (t) => {
  const { read } = await connect(t, [
    { path: issue, method: 'POST', body: task({ issuetype: { name: 'Story' }, labels: ['QA-Testable'], customfield_34: 3 }), status: 503 },
    { path: ticket, method: 'PUT', body: { fields: { summary: 'New summary' } }, networkFailure: true },
    { path: ticket, method: 'PUT', body: { fields: { summary: 'New summary' } }, status: 204 },
    { path: sprint, method: 'POST', body: { issues: ['DEMO-7'] }, status: 504 },
  ], { AUTO_CREATE_TEST_TICKETS: 'true', JIRA_STORY_POINTS_FIELD: 'customfield_34' });
  const created = await read('create-ticket', { summary: 'A task', issue_type: 'Story', story_points: 3, sprint_id: 14 }, true);
  assert.deepEqual(writeStates(created), { create_ticket: 'uncertain', move_to_sprint: 'not_attempted', create_test_ticket: 'not_attempted', link_test_ticket: 'not_attempted' });
  assert.equal(created.steps.create_ticket.status, 503);
  assert.match(created.steps.create_ticket.recovery, /Search Jira/);
  const args = { ticket_key: 'DEMO-7', summary: 'New summary', sprint_id: 14 };
  const updateInterrupted = await read('update-ticket', args, true);
  assert.deepEqual(writeStates(updateInterrupted), { update_ticket: 'uncertain', move_to_sprint: 'not_attempted' });
  assert.match(updateInterrupted.steps.update_ticket.recovery, /Check the ticket's fields/);
  const moveInterrupted = await read('update-ticket', args, true);
  assert.deepEqual(writeStates(moveInterrupted), { update_ticket: 'done', move_to_sprint: 'uncertain' });
  assert.equal(moveInterrupted.ticket_key, 'DEMO-7');
  assert.equal(moveInterrupted.steps.move_to_sprint.status, 504);
});

test('HTTP failures are safe MCP errors, GET honors Retry-After and uncertain writes are not retried', async (t) => {
  const { read } = await connect(t, [
    { path: issue, method: 'POST', body: task(), status: 401, echoSecrets: true },
    { path: own, status: 403, text: `not JSON ${token}` },
    { path: own, status: 429, headers: { 'Retry-After': '0' } },
    { path: own, json: { accountId: 'user-a' } },
    { path: own, status: 429, headers: { 'Retry-After': '1000' } },
    { path: issue, method: 'POST', body: task(), status: 429, headers: { 'Retry-After': '0' } },
    { path: issue, method: 'POST', body: task(), networkFailure: true },
    { path: own, json: { accountId: 'user-b' } },
  ]);
  const error = (await read('create-ticket', { summary: 'A task' }, true)).steps.create_ticket;
  assert.equal(error.status, 401);
  assert.equal(error.state, 'rejected');
  assert.equal(error.operation, 'create ticket');
  assert.match(error.errors.summary, /Summary rejected.*REDACTED/);
  assert.match(error.errorMessages[0], /Denied.*REDACTED/);
  for (const secret of [token, username, Buffer.from(`${username}:${token}`).toString('base64'), 'RAW_RESPONSE_SENTINEL']) {
    assert.ok(!JSON.stringify(error).includes(secret));
  }
  const nonJson = await read('get-myself', {}, true);
  assert.equal(nonJson.status, 403);
  assert.ok(!JSON.stringify(nonJson).includes(token));
  assert.equal((await read('get-myself')).accountId, 'user-a');
  assert.equal((await read('get-myself', {}, true)).status, 429);
  assert.equal((await read('create-ticket', { summary: 'A task' }, true)).steps.create_ticket.status, 429);
  const uncertain = (await read('create-ticket', { summary: 'A task' }, true)).steps.create_ticket;
  assert.equal(uncertain.state, 'uncertain');
  assert.match(uncertain.error, /verify whether the write succeeded/);
  assert.ok(!JSON.stringify(uncertain).includes(token));
  assert.equal((await read('get-myself')).accountId, 'user-b');
});
