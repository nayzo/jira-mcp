import 'dotenv/config';
import { JiraClient } from '../build/jira/api.js';
import { OperationError } from '../build/http.js';
import { addZephyrTestStep, getJiraTestIds } from '../build/zephyr/test-steps.js';

const key = process.argv[2] || process.env.TICKET_KEY;
if (!key) {
    console.error('Specify the test ticket key as an argument or TICKET_KEY');
    process.exitCode = 1;
} else {
    try {
        const { issueId, projectId } = await getJiraTestIds(new JiraClient(), key);
        await addZephyrTestStep(issueId, projectId, { step: 'Verify logout functionality', result: 'The session ends' });
        console.log('Added a test step');
    } catch (error) {
        console.error(error instanceof OperationError ? error.message : 'Zephyr test step creation failed');
        process.exitCode = 1;
    }
}
