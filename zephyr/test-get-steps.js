import 'dotenv/config';
import { JiraClient } from '../build/jira/api.js';
import { OperationError } from '../build/http.js';
import { getJiraTestIds, getZephyrTestSteps } from '../build/zephyr/test-steps.js';

const key = process.argv[2] || process.env.TICKET_KEY || 'PROJECT-123';
try {
    const { issueId, projectId } = await getJiraTestIds(new JiraClient(), key);
    const steps = await getZephyrTestSteps(issueId, projectId);
    console.log(`Retrieved ${steps.length} test step(s)`);
} catch (error) {
    console.error(error instanceof OperationError ? error.message : 'Zephyr test step lookup failed');
    process.exitCode = 1;
}
