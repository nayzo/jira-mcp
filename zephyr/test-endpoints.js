import 'dotenv/config';
import { JiraClient } from '../build/jira/api.js';
import { OperationError, requestJson } from '../build/http.js';
import { generateZephyrJwt } from '../build/zephyr/auth.js';
import { getJiraTestIds } from '../build/zephyr/test-steps.js';

const key = process.argv[2] || process.env.TICKET_KEY || 'DEMO-123';
try {
    const { issueId } = await getJiraTestIds(new JiraClient(), key);
    const base = (process.env.ZAPI_BASE_URL || 'https://prod-api.zephyr4jiracloud.com/connect').replace(/\/$/, '');
    for (const resource of ['teststep', 'steps', 'teststeps', 'test/steps']) {
        for (const suffix of ['', '/']) {
            const label = `${resource}/<issueId>${suffix}`;
            const path = `/public/rest/api/1.0/${resource}/${encodeURIComponent(issueId)}${suffix}`;
            try {
                await requestJson(`${base}${path}`, 'probe Zephyr endpoint', 'GET', {
                    Authorization: `JWT ${generateZephyrJwt('GET', path)}`,
                    zapiAccessKey: process.env.ZAPI_ACCESS_KEY || '',
                }, undefined, false);
                console.log(`${label}: OK`);
            } catch (error) {
                console.error(`${label}: ${error instanceof OperationError ? error.message : 'probe failed'}`);
            }
        }
    }
} catch (error) {
    console.error(error instanceof OperationError ? error.message : 'Zephyr endpoint checks failed');
    process.exitCode = 1;
}
