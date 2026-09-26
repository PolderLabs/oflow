import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Execute the exact embedded browser program without requiring a concurrent build.
const source = readFileSync(new URL('../src/dashboard-insights.ts', import.meta.url), 'utf8').split('export const dashboardInsightsScript = String.raw`')[1].slice(0,-3);
function harness(responses = {}) {
  const calls = [];
  const context = vm.createContext({ api: async path => { calls.push(path); if (responses[path] instanceof Error) throw responses[path]; return responses[path] || {}; }, esc: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) });
  vm.runInContext(source, context);
  return {...vm.runInContext('({buildDashboardInsights, renderDashboardInsights})',context),calls};
}
const stamp = '2026-01-02T10:00:00Z';
const data = () => ({ status:{latestSync:{generatedAt:stamp}},workItems:[],pipelines:[],syncHistory:[] });
const job = (overrides={}) => ({action:'assess',story:2,status:'succeeded',finishedAt:stamp,result:{story:{iid:2},criteria:[{status:'unknown'}],nextActions:['Collect evidence'],blockers:[]},...overrides});

test('recommendations distinguish bounded missing planning from failures and unknown fields', () => {
  const input = data(); input.workItems = [{iid:1,state:'opened',assignees:[],iteration:null,milestone:null},{iid:2,state:'opened'},{iid:3,state:'closed',assignees:[],iteration:null,milestone:null}]; input.workItemsMayBeTruncated = true;
  const result = harness().buildDashboardInsights(input,{});
  assert.equal(result.recommendations.length,2);
  assert.equal(result.recommendations[0].href,'#story/1');
  assert.match(result.recommendations[1].reason,/not a delivery failure/);
  assert.match(result.notices.join(),/truncated/);
});
test('pipeline failures are project scoped and never linked to a story', () => {
  const input = data(); input.pipelines = [{status:'failed'}];
  const result = harness().buildDashboardInsights(input,{});
  assert.equal(result.recommendations[0].href,'#delivery');
  assert.match(result.recommendations[0].reason,/not attributed/);
});
test('assessment recommendations require succeeded exact-story results and prefer newest success', () => {
  const jobs = [job({status:'failed'}),job({story:3}),job(),job({finishedAt:'2025-01-01',result:{story:{iid:2},nextActions:['Obsolete']}})];
  const result = harness().buildDashboardInsights(data(),{actions:{value:{jobs}}});
  assert.equal(result.recommendations.length,1);
  assert.match(result.recommendations[0].reason,/Collect evidence/);
  assert.doesNotMatch(result.recommendations[0].reason,/Obsolete/);
  assert.match(result.recommendations[0].source,/may be stale/);
});
test('timeline merges dated local evidence and observed snapshots without claiming movement', () => {
  const input=data(); input.syncHistory=[{generatedAt:'2026-01-01',source:'sync'},{generatedAt:'invalid'}];
  const result=harness().buildDashboardInsights(input,{actions:{value:{jobs:[job()]}},audit:{value:{events:[{at:'2026-01-03',action:'approved',planId:'p1',state:'approved'}],mayBeTruncated:true}},verification:{value:{state:'stale',reason:'Tree changed',lastRun:{ranAt:'2026-01-04',status:'passed'}}}});
  assert.equal(result.timeline.length,4);
  assert.equal(result.timeline[0].kind,'Local verification');
  assert.equal(result.timeline.at(-1).kind,'Observed GitLab snapshot');
  assert.match(result.timeline.at(-1).detail,/not a work-item movement/);
  assert.match(result.notices.join(),/undated/);
  assert.match(result.notices.join(),/bounded/);
  assert.match(result.recommendations.at(-1).source,/not story-specific/);
});
test('missing sources are explicit and do not become evidence of success', async () => {
  const h=harness({'/api/actions':new Error('unavailable'),'/api/audit':new Error('denied')}); const host={};
  await h.renderDashboardInsights(host,data());
  assert.deepEqual(h.calls.sort(),['/api/actions','/api/audit','/api/verification']);
  assert.match(host.innerHTML,/actions unavailable/); assert.match(host.innerHTML,/audit unavailable/);
  assert.match(host.innerHTML,/does not prove/);
});
test('rendered evidence escapes hostile values and only constructs internal links', async () => {
  const input=data(); input.warnings=['<script>alert(1)</script>'];
  const h=harness({'/api/actions':{jobs:[job({error:'<img src=x onerror=x>',action:'<svg onload=x>'})]}}); const host={};
  await h.renderDashboardInsights(host,input);
  assert.doesNotMatch(host.innerHTML,/<script>|<img|<svg/);
  assert.match(host.innerHTML,/&lt;script&gt;/);
  assert.match(host.innerHTML,/href="#story\/2"/);
});
test('undated snapshots disclose unknown freshness rather than manufacturing time', () => {
  const input=data(); input.status={}; input.workItems=[{iid:1,assignees:[]}];
  const result=harness().buildDashboardInsights(input,{});
  assert.equal(result.recommendations[0].at,null);
  assert.match(result.notices.join(),/freshness are unknown/);
});

test('recorded assessment and verification remain ahead of routine planning suggestions', () => {
  const input=data(); input.workItems=Array.from({length:30},(_,i)=>({iid:i+1,state:'opened',assignees:[]}));
  const result=harness().buildDashboardInsights(input,{actions:{value:{jobs:[job()]}},verification:{value:{state:'missing',reason:'No run recorded'}}});
  assert.match(result.recommendations[0].title,/Review assessment/);
  assert.match(result.recommendations[1].title,/verification/);
});
