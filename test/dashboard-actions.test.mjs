import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardActions, parseDashboardAction, dashboardActionArgs, projectDashboardActionResult } from '../dist/dashboard-actions.js';
import { startDashboard } from '../dist/dashboard.js';

// fetch() drops a Host override before it reaches the wire, so a forged Host
// can only be exercised on a raw socket. Returns the response status line.
function rawPost(base, path, host) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      const payload = JSON.stringify({ action: 'refresh' });
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`,
      );
    });
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve(status);
    });
  });
}

function runner() {
  let finish;
  let terminated = 0;
  const calls = [];
  const run = (args, root) => {
    calls.push({ args, root });
    return { completed: new Promise(resolve => { finish = resolve; }), terminate: () => { terminated++; } };
  };
  return { run, calls, finish: value => finish(value), get terminated() { return terminated; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('action schema rejects executable flags, coercion, missing stories, and unsupported operations', () => {
  for (const value of [null, [], {}, {action:'apply'}, {action:'context'}, {action:'assess',story:'2'}, {action:'handoff',story:0}, {action:'assess',story:2.5}, {action:'refresh',story:2}, {action:'refresh',args:['--host','bad']}, {action:'context',story:2,root:'/tmp'}]) {
    assert.throws(() => parseDashboardAction(value), {code:'INVALID_DASHBOARD_ACTION'});
  }
  assert.deepEqual(parseDashboardAction({action:'assess',story:2}), {action:'assess',story:2});
  assert.deepEqual(dashboardActionArgs('refresh',null), ['sync','--refresh','--json']);
  assert.deepEqual(dashboardActionArgs('context',2), ['context','--story','2','--json']);
});

test('job bridge is explicit, fixed-root, single-flight and projects completed results', async () => {
  const fake = runner();
  const actions = new DashboardActions('/tmp/example', fake.run);
  assert.deepEqual(actions.list(), []);
  assert.equal(fake.calls.length, 0);
  const job = await actions.start({action:'context',story:3});
  assert.equal(job.status, 'running');
  assert.deepEqual(fake.calls[0], {args:['context','--story','3','--json'],root:'/tmp/example'});
  await assert.rejects(actions.start({action:'refresh'}), {code:'DASHBOARD_ACTION_BUSY'});
  fake.finish({code:0,stdout:JSON.stringify({story:{iid:3,title:'Title',token:'private'},unknown:'hidden'})});
  await tick();
  assert.equal(actions.get(job.id).status,'succeeded');
  assert.deepEqual(actions.get(job.id).result,{story:{iid:3,title:'Title'}});
  const copy=actions.list(); copy[0].status='failed';
  assert.equal(actions.get(job.id).status,'succeeded');
});

test('cancellation terminates process and holds slot until process exits', async () => {
  const fake=runner(), actions=new DashboardActions('/tmp/example',fake.run);
  const job=await actions.start({action:'handoff',story:1});
  assert.equal(actions.cancel(job.id).status,'cancelled');
  assert.equal(fake.terminated,1);
  await assert.rejects(actions.start({action:'refresh'}),{code:'DASHBOARD_ACTION_BUSY'});
  fake.finish({code:0,stdout:'{"title":"ignored"}'}); await tick();
  assert.equal(actions.get(job.id).status,'cancelled');
  assert.equal(actions.get(job.id).result,null);
  assert.ok(actions.get(job.id).finishedAt);
  assert.equal(actions.cancel('unknown'),null);
});

test('timeouts, output overflow, malformed results fail without leaking output', async () => {
  for (const output of [{code:1,stdout:'password raw failure'}, {code:0,stdout:'not-json'}, {code:0,stdout:'{"title":"secret"}',overflow:true}]) {
    const fake=runner(), actions=new DashboardActions('/tmp/example',fake.run);
    const job=await actions.start({action:'refresh'}); fake.finish(output); await tick();
    const result=actions.get(job.id);
    assert.equal(result.status,'failed'); assert.equal(result.result,null);
    assert.doesNotMatch(result.error,/password|raw failure|not-json|secret/);
  }
  const fake=runner(), actions=new DashboardActions('/tmp/example',fake.run,5);
  const job=await actions.start({action:'refresh'});
  await new Promise(resolve=>setTimeout(resolve,15)); assert.equal(fake.terminated,1);
  fake.finish({code:0,stdout:'{}'}); await tick(); assert.equal(actions.get(job.id).status,'failed');
});

test('failed configured verification preserves structured evidence, never command output', async () => {
  const fake=runner(), actions=new DashboardActions('/tmp/example',fake.run);
  const job=await actions.start({action:'assess',story:1});
  fake.finish({code:1,stdout:JSON.stringify({status:'failed',perCheck:[{id:'tests',status:'failed',output:'secret',command:['anything'],exitCode:1}]})}); await tick();
  assert.deepEqual(actions.get(job.id).result,{status:'failed',perCheck:[{id:'tests',status:'failed',exitCode:1}]});
});

test('projection scrubs secrets in permitted text and rejects newly introduced fields', () => {
  const result=projectDashboardActionResult({title:'glpat-example Bearer abc.secret env-secret https://user:pass@example.test/?token=abc',tokenValue:'hidden',criteria:[{text:'env-secret'}]},['env-secret']);
  assert.doesNotMatch(JSON.stringify(result),/glpat-example|abc.secret|env-secret|user:pass|token=abc|hidden/);
  assert.equal(result.criteria[0].text,'[redacted]');
});

test('unconfigured verification never launches a process', async () => {
  const root=await mkdtemp(join(tmpdir(),'oflow-actions-'));
  try {
    const fake=runner(), actions=new DashboardActions(root,fake.run);
    await assert.rejects(actions.start({action:'verify-local'}),{code:'DASHBOARD_CHECKS_UNCONFIGURED'});
    assert.equal(fake.calls.length,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('HTTP action routes enforce origin, host, schema, methods and cancellation', async () => {
  const root=await mkdtemp(join(tmpdir(),'oflow-actions-http-')), fake=runner();
  const dashboard=await startDashboard(root,{port:0,actionRunner:fake.run});
  const post=(path,body,headers={})=>fetch(dashboard.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  try {
    assert.deepEqual(await (await fetch(dashboard.url+'api/actions')).json(),{jobs:[]});
    assert.equal(fake.calls.length,0);
    assert.equal((await post('api/actions',{action:'refresh'},{Origin:'https://other.test'})).status,403);
    // fetch() silently drops a Host override, so this cannot go through post();
    // the forged header has to be written on a raw socket to reach the guard.
    assert.equal(await rawPost(dashboard.url,'/api/actions','attacker.test'),403);
    assert.equal((await post('api/actions','{broken')).status,400);
    assert.equal((await post('api/actions',{action:'apply'})).status,400);
    const response=await post('api/actions',{action:'assess',story:8},{Origin:dashboard.url.slice(0,-1)});
    assert.equal(response.status,202); const job=await response.json();
    assert.equal((await post('api/actions',{action:'refresh'})).status,409);
    assert.equal((await fetch(dashboard.url+'api/actions/'+job.id+'/cancel')).status,405);
    assert.equal((await fetch(dashboard.url+'api/actions/'+job.id)).status,200);
    assert.equal((await post('api/actions/'+job.id+'/cancel',{})).status,200);
    assert.equal(fake.terminated,1); fake.finish({code:null,stdout:''}); await tick();
    assert.equal((await (await fetch(dashboard.url+'api/actions/'+job.id)).json()).status,'cancelled');
    assert.equal((await fetch(dashboard.url+'api/actions/missing')).status,404);
  } finally { await dashboard.close(); await rm(root,{recursive:true,force:true}); }
});
