import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO_REF_EXPR, wifMember } from './setup-cicd.js';

const POOL = 'iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/agentq-pool';

test('per-repo branch binding pins repo + ref without relying on the sub format', () => {
  const m = wifMember('123456789', 'agentq-pool', 'ExampleOrg', 'example-agent', 'refs/heads/staging',
    { scope: 'repo', refMatch: 'exact' });
  assert.equal(m, `principalSet://${POOL}/attribute.repo_ref/ExampleOrg/example-agent/refs/heads/staging`);
  assert.ok(!m.includes('/subject/'));
});

test('repo_ref mapping yields the same <org>/<repo>/<ref> the binding expects', () => {
  // GitHub OIDC claims for a push to staging (same with the immutable-ID `sub`).
  const assertion = { repository: 'ExampleOrg/example-agent', ref: 'refs/heads/staging' };
  const value = REPO_REF_EXPR.replace("assertion.repository + '/' + assertion.ref",
    `${assertion.repository}/${assertion.ref}`);
  assert.equal(value, 'ExampleOrg/example-agent/refs/heads/staging');
});

test('org-wide scopes are unchanged', () => {
  assert.equal(wifMember('1', 'p', 'Org', 'r', 'refs/heads/dev', { scope: 'org', refMatch: 'exact' }),
    'principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/attribute.ref/refs/heads/dev');
  assert.equal(wifMember('1', 'p', 'Org', 'r', 'refs/pull/*', { scope: 'org', refMatch: 'pr-prefix' }),
    'principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/attribute.repository_owner/Org');
});
