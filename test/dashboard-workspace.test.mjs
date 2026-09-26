import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/dashboard-workspace.ts', import.meta.url), 'utf8');
const script = source.split('export const dashboardWorkspaceScript = String.raw`')[1].split('\n`;')[0];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function harness(data = {}, jobs = []) {
  const calls = [], buttons = [], timers = [];
  const host = { innerHTML:'', isConnected:true, querySelectorAll(selector) { if (selector === '[data-story-action]') { buttons.length = 0; for (const action of ['context','assess','handoff','verify-local']) buttons.push({dataset:{storyAction:action},addEventListener(_name,fn){this.click = fn;}}); return buttons; } return []; } };
  const context = vm.createContext({ URL, esc, safeUrl: value => /^https?:\/\//.test(value || '') ? true : false, link:(label,url) => /^https?:\/\//.test(url || '') ? '<a href="' + esc(url) + '">' + esc(label) + '</a>' : esc(label), command:(value,label) => '<button data-copy="' + esc(value) + '">' + esc(label) + '</button>', location:{hash:'#story/1'}, clearTimeout(){}, setTimeout(fn){timers.push(fn);return timers.length;}, api:async(path,options) => {calls.push({path,options}); if (path === '/api/data') return data; if (!options) return {jobs}; return {id:'new',story:1,action:JSON.parse(options.body).action,status:'running',startedAt:'2026-01-01'}; } });
  vm.runInContext(script + '\nthis.workspace = {renderStoryWorkspace,workspaceRelations,workspaceLatest,workspaceBrief,workspaceHandoffChanges};', context);
  return {...context.workspace,host,calls,buttons,timers,context};
}
const item = {iid:1,title:'Story',webUrl:'https://gitlab.example.com/team/repo/-/issues/1',labels:[],assignees:[]};
const handoff = {generatedAt:'2026-01-01',story:{iid:1,title:'Story'},criteria:[],local:{branch:'main',clean:true,changedFiles:[]},blockers:[],nextActions:[]};
test('initial workspace is cache-only and discloses unknown evidence', async () => {
  const h = harness({workItems:[item]}); await h.renderStoryWorkspace(h.host,1);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/data','/api/actions']);
  assert.match(h.host.innerHTML,/Description is unknown/); assert.match(h.host.innerHTML,/Project-wide pipelines are not attributed/);
  assert.match(h.host.innerHTML,/Nothing runs automatically/); assert.match(h.host.innerHTML,/repository-configured verification/);
});
test('workspace escapes all project strings and rejects unsafe links', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const h = harness({workItems:[{...item,title:hostile,webUrl:'javascript:alert(1)',parent:{title:hostile,webUrl:'javascript:alert(1)'}}]},[{id:'a',action:'context',story:1,status:'succeeded',result:{story:{iid:1,description:hostile},criteria:[{id:hostile,text:hostile}]}}]);
  await h.renderStoryWorkspace(h.host,1);
  assert.doesNotMatch(h.host.innerHTML,/<img|href="javascript/); assert.match(h.host.innerHTML,/&lt;img/);
});
test('relationships require unique canonical URLs rather than matching IID', () => {
  const h = harness(); const child = {...item,iid:2,webUrl:item.webUrl.replace('/1','/2'),parent:{iid:1,webUrl:'https://gitlab.example.com/other/repo/-/issues/1'}};
  assert.equal(h.workspaceRelations(child,[item,child]).parent,null);
  child.parent.webUrl = item.webUrl + '/#note'; assert.equal(h.workspaceRelations(child,[item,child]).parent,item);
  assert.equal(h.workspaceRelations(child,[item,{...item},child]).parent,null);
});
test('only matching successful story results contribute evidence', () => {
  const h = harness(); assert.equal(h.workspaceLatest([{story:1,action:'assess',status:'succeeded',result:{story:{iid:2}}}],'assess',1),null);
  assert.equal(h.workspaceLatest([{story:1,action:'assess',status:'failed',result:{story:{iid:1}}}],'assess',1),null);
});
test('explicit action submits fixed name and story and polling stops after navigation', async () => {
  const h = harness({workItems:[item]}); await h.renderStoryWorkspace(h.host,1); await h.buttons.find(button => button.dataset.storyAction === 'context').click();
  const request = h.calls.at(-1); assert.equal(request.options.method,'POST'); assert.deepEqual(JSON.parse(request.options.body),{action:'context',story:1});
  h.context.location.hash = '#overview'; const count = h.calls.length; await h.timers.at(-1)(); assert.equal(h.calls.length,count);
});
test('brief records constraints and return contract; resume does not invent history', () => {
  const h = harness(); const brief = h.workspaceBrief(handoff,null); assert.match(brief,/plan → approve → apply → verify/); assert.match(brief,/Return contract/); assert.match(brief,/completeness is unknown/);
  assert.match(h.workspaceHandoffChanges(handoff,null)[0],/No earlier successful/);
  assert.match(h.workspaceHandoffChanges(handoff,{...handoff,generatedAt:'2025-01-01'})[0],/No changes/);
  assert.match(h.workspaceHandoffChanges({...handoff,blockers:['check failed']},handoff).join(' '),/Blockers changed/);
});
test('handoff preview and observed evidence are readable while unsafe content stays escaped', async () => {
  const h = harness({workItems:[item]},[{id:'h',story:1,action:'handoff',status:'succeeded',result:{...handoff,blockers:['<script>unsafe</script>'],nextActions:['Run checks']}}]); await h.renderStoryWorkspace(h.host,1);
  assert.match(h.host.innerHTML,/Copy agent brief/); assert.match(h.host.innerHTML,/Preview agent brief/); assert.match(h.host.innerHTML,/Run checks/); assert.doesNotMatch(h.host.innerHTML,/<script>/);
});
test('missing cached story reports coverage rather than absence and issues no actions',async () => {
  const h = harness({workItems:[]}); await h.renderStoryWorkspace(h.host,1); assert.match(h.host.innerHTML,/not evidence that it does not exist/); assert.equal(h.calls.some(call => call.options),false);
});
test('disposing a workspace stops background action polling',async () => {
  const h = harness({workItems:[item]},[{id:'running',story:1,action:'context',status:'running'}]); await h.renderStoryWorkspace(h.host,1);
  h.host.dispose(); const before = h.calls.length; await h.timers.at(-1)(); assert.equal(h.calls.length,before);
});
test('newer handoff delivery evidence is not replaced by an older assessment',async () => {
  const h = harness({workItems:[item]},[
    {id:'new',story:1,action:'handoff',status:'succeeded',result:{...handoff,pipeline:{id:9,status:'success'}}},
    {id:'old',story:1,action:'assess',status:'succeeded',result:{...handoff,remote:{pipeline:{id:8,status:'failed'}},criteria:[]}}
  ]); await h.renderStoryWorkspace(h.host,1); assert.match(h.host.innerHTML,/#9 · success/); assert.doesNotMatch(h.host.innerHTML,/#8 · failed/);
});
test('repository verification cannot launch without explicit trust confirmation',async () => {
  const h = harness({workItems:[item]}); await h.renderStoryWorkspace(h.host,1);
  assert.match(h.host.innerHTML,/data-story-action="verify-local" disabled/);
  const before = h.calls.length; await h.buttons.find(button => button.dataset.storyAction === 'verify-local').click(); assert.equal(h.calls.length,before);
});
test('workspace uses shell link helper argument order',async () => {
  const h = harness({workItems:[item]}); await h.renderStoryWorkspace(h.host,1); assert.match(h.host.innerHTML, /href="https:\/\/gitlab.example.com\/team\/repo\/-\/issues\/1">Open in GitLab/);
});
