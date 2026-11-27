import 'dotenv/config';
import { JiraClient, issuePath } from '../build/jira/api.js';
import { OperationError } from '../build/http.js';

const key = process.argv[2] || process.env.TICKET_KEY || 'DEMO-123';
try {
    await new JiraClient().get('query Jira issue', issuePath(key), { fields: 'issuetype,status' });
    console.log('Issue retrieved');
} catch (error) {
    console.error(error instanceof OperationError ? error.message : 'Issue query failed');
    process.exitCode = 1;
}
