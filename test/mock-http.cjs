const assert = require('node:assert/strict');

const fixtures = JSON.parse(process.env.TEST_HTTP_FIXTURES);
let next = 0;

globalThis.fetch = async (input, init) => {
  const index = next++;
  const fixture = fixtures[index];
  try {
    assert(fixture);
    const url = new URL(input);
    assert.equal(url.origin, fixture.origin ?? 'https://jira.example.invalid');
    assert.equal(url.pathname, fixture.path);
    assert.equal(init.method, fixture.method ?? 'GET');
    assert.deepEqual(Object.fromEntries(url.searchParams), fixture.query ?? {});
    assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), fixture.body);
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    if (!fixture.origin) {
      assert.equal(headers.get('Authorization'), `Basic ${Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`);
    } else {
      assert.match(headers.get('Authorization'), /^JWT /);
      assert.equal(headers.get('zapiAccessKey'), process.env.ZAPI_ACCESS_KEY);
    }
  } catch {
    console.error(`Unexpected mock HTTP request ${index + 1}: ${init.method} ${new URL(input).pathname}`);
    throw new Error('Mock HTTP request did not match fixture');
  }
  console.error(`Matched HTTP fixture ${index + 1}`);
  if (fixture.networkFailure) throw new Error(process.env.JIRA_API_TOKEN);
  if (fixture.echoSecrets) {
    const secret = fixture.origin ? process.env.ZAPI_SECRET_KEY : process.env.JIRA_API_TOKEN;
    return new Response(JSON.stringify({
      errorMessages: [`Denied: ${init.headers.Authorization} ${init.headers.zapiAccessKey ?? ''} ${secret}`],
      errors: { summary: `Summary rejected ${secret}` },
      internal: 'RAW_RESPONSE_SENTINEL',
    }), { status: fixture.status });
  }
  return new Response(fixture.text ?? (fixture.json === undefined ? null : JSON.stringify(fixture.json)), {
    status: fixture.status ?? 200, headers: fixture.headers,
  });
};
