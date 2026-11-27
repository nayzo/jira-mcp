import 'dotenv/config';
import { JiraClient } from '../build/jira/api.js';
import { OperationError } from '../build/http.js';
import { getJiraTestIds, getZephyrTestSteps } from '../build/zephyr/test-steps.js';

const key = process.argv[2] || process.env.TICKET_KEY || 'DEMO-123';
try {
    const { issueId, projectId } = await getJiraTestIds(new JiraClient(), key);
    const steps = await getZephyrTestSteps(issueId, projectId);
    console.log(`Zephyr accepted projectId and returned ${steps.length} test step(s)`);
} catch (error) {
    console.error(error instanceof OperationError ? error.message : 'Zephyr project ID check failed');
    process.exitCode = 1;
}
