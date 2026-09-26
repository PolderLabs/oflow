/** Read-only, source-labelled recommendations and local delivery history. */
export const dashboardInsightsCss = String.raw`
.insights-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;margin-block:24px}.insights-panel{min-width:0;background:var(--surface,#fff);border:1px solid var(--line,#dce3df);border-radius:18px;padding:22px}.insights-panel h2{margin:0 0 8px}.insights-intro,.insights-evidence{font-size:12px;color:var(--muted,#596963);line-height:1.6}.insights-list{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}.insights-list li{border-top:1px solid var(--line,#dce3df);padding-top:12px;overflow-wrap:anywhere}.insights-list h3{font-size:14px;margin:5px 0}.insights-list p{margin:5px 0;line-height:1.5;font-size:13px}.insights-kind{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted,#596963)}.insights-link{display:inline-block;margin-top:6px;font-size:12px;font-weight:700}.insights-notice{padding:10px 12px;background:#fff5dc;border-radius:8px;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.insights-timeline time{font-size:11px;color:var(--muted,#596963)}@media(max-width:900px){.insights-grid{grid-template-columns:1fr}.insights-panel{padding:16px}}
`;

export const dashboardInsightsScript = String.raw`
function insightTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}
function insightStory(value) { return Number.isSafeInteger(value) && value > 0; }
function buildDashboardInsights(data, sources) {
  const recommendations = [], timeline = [], notices = [];
  const snapshotAt = insightTime(data.status?.latestSync?.generatedAt);
  const add = (title, reason, source, at, href, action) => recommendations.push({title,reason,source,at:insightTime(at),href,action});
  for (const item of data.workItems || []) {
    if (!insightStory(item.iid) || String(item.state).toLowerCase() === 'closed') continue;
    const href = '#story/' + item.iid;
    if (Array.isArray(item.assignees) && item.assignees.length === 0) add('#' + item.iid + ' · Assign an owner', 'No assignee is recorded in this bounded snapshot. Confirm ownership before starting.', 'Cached GitLab work item', snapshotAt, href, 'Review story');
    if (item.iteration === null && item.milestone === null) add('#' + item.iid + ' · Review planning', 'Neither an iteration nor a milestone is recorded. This may be intentional backlog work, not a delivery failure.', 'Cached GitLab work item', snapshotAt, href, 'Review story');
  }
  const failedPipelines = (data.pipelines || []).filter(item => item.status === 'failed');
  if (failedPipelines.length) add('Review failed pipeline observations', failedPipelines.length + ' failed pipeline(s) appear in the cached project snapshot. They are not attributed to a story.', 'Cached GitLab pipelines', snapshotAt, '#delivery', 'Inspect delivery');
  if (!snapshotAt) notices.push('No dated GitLab snapshot is available. Cached coverage and freshness are unknown.');
  if (data.workItemsMayBeTruncated) notices.push('Work-item coverage is bounded and may be truncated; recommendations are not a project-wide audit.');
  if (data.status?.invalidation?.at) notices.push('The snapshot has been invalidated. Refresh before relying on recommendations.');
  for (const warning of data.warnings || []) notices.push('Snapshot warning: ' + warning);
  for (const [name, source] of Object.entries(sources)) if (source.error) notices.push(name + ' unavailable: ' + source.error + '. This is missing evidence, not an empty history.');
  const jobs = sources.actions?.value?.jobs || [];
  const assessments = new Map();
  for (const job of [...jobs].sort((a,b) => (Date.parse(insightTime(b.finishedAt) || '') || 0) - (Date.parse(insightTime(a.finishedAt) || '') || 0))) {
    if (job.action !== 'assess' || job.status !== 'succeeded' || !insightStory(job.story) || job.result?.story?.iid !== job.story || assessments.has(job.story)) continue;
    assessments.set(job.story, job);
    const result = job.result, href = '#story/' + job.story;
    const at = insightTime(result.generatedAt) || insightTime(job.finishedAt);
    const blockers = Array.isArray(result.blockers) ? result.blockers : [];
    const unresolved = (result.criteria || []).filter(criterion => criterion.status !== 'satisfied');
    const next = (result.nextActions || []).join(' ');
    if (blockers.length || unresolved.length || next) add('#' + job.story + ' · Review assessment', (blockers.length ? 'Recorded blockers: ' + blockers.join(' ') + ' ' : '') + (unresolved.length ? unresolved.length + ' acceptance criteria need review; unknown evidence is not a confirmed failure. ' : '') + next, 'Recorded local assessment; may be stale', at, href, 'Review evidence');
    for (const warning of result.warnings || []) notices.push('Assessment #' + job.story + ': ' + warning);
  }
  const verification = sources.verification?.value;
  if (verification && typeof verification.state === 'string' && verification.state !== 'passed') add('Review repository verification', verification.reason || 'Current verification evidence needs review.', 'Local Git-tree verification (' + verification.state + '); not story-specific', verification.lastRun?.ranAt, '#lifecycle', 'Inspect verification');
  function event(kind,title,detail,at,href) { const valid = insightTime(at); if (valid) timeline.push({kind,title,detail,at:valid,href}); else notices.push('An undated ' + kind.toLowerCase() + ' record was omitted from chronological history.'); }
  for (const job of jobs) event('Local action', job.action + ' · ' + job.status + (insightStory(job.story) ? ' · #' + job.story : ''), job.error || (job.status === 'succeeded' ? 'Execution completed; inspect its evidence before treating the work as verified.' : 'Recorded dashboard action status.'), job.finishedAt || job.startedAt, insightStory(job.story) ? '#story/' + job.story : '#lifecycle');
  for (const entry of sources.audit?.value?.events || []) event('Local plan audit', entry.action + ' · ' + entry.planId, (entry.operation?.kind || 'Plan') + ' · ' + (entry.operation?.target || '') + ' · ' + entry.state, entry.at, '#lifecycle');
  if (sources.audit?.value?.mayBeTruncated) notices.push('Plan audit history is bounded; older events may not be shown.');
  if (verification?.lastRun) event('Local verification', 'Repository checks · ' + verification.lastRun.status, 'Recorded check run. Current evidence state: ' + verification.state + '. Not evidence of a GitLab stage transition.', verification.lastRun.ranAt, '#lifecycle');
  for (const snapshot of data.syncHistory || []) event('Observed GitLab snapshot', 'Snapshot recorded', 'Source: ' + (snapshot.source || 'unknown') + '. A point-in-time observation, not a work-item movement event.', snapshot.generatedAt, '#overview');
  timeline.sort((a,b) => Date.parse(b.at) - Date.parse(a.at));
  const priority = item => item.source.startsWith('Recorded local assessment') ? 0 : item.source.startsWith('Local Git-tree') ? 1 : item.source === 'Cached GitLab pipelines' ? 2 : 3;
  recommendations.sort((a,b) => priority(a) - priority(b));
  return {recommendations,timeline,notices};
}
async function renderDashboardInsights(host, data) {
  host.innerHTML = '<p role="status">Loading local evidence and activity…</p>';
  const sources = {};
  await Promise.all(['actions','audit','verification'].map(async name => {
    try { sources[name] = {value:await api('/api/' + name)}; }
    catch (error) { sources[name] = {error:error instanceof Error ? error.message : String(error)}; }
  }));
  const model = buildDashboardInsights(data, sources);
  const date = value => value ? '<time datetime="' + esc(value) + '">' + esc(new Date(value).toLocaleString()) + '</time>' : 'Time unknown';
  host.innerHTML = '<div class="insights-grid"><section class="insights-panel" aria-label="Recommended next actions"><p class="eyebrow">Evidence → next step</p><h2>What needs attention?</h2><p class="insights-intro">Suggestions, not automatic decisions. Scope: loaded work items and recorded local evidence. Open a story to inspect context before acting.</p>' + (model.recommendations.length ? '<ul class="insights-list">' + model.recommendations.slice(0,20).map(item => '<li><h3>' + esc(item.title) + '</h3><p>' + esc(item.reason) + '</p><div class="insights-evidence">' + esc(item.source) + ' · ' + date(item.at) + '</div><a class="insights-link" href="' + esc(item.href) + '">' + esc(item.action) + ' →</a></li>').join('') + '</ul>' : '<p>No recommendations from the available evidence. This does not prove that all work is complete.</p>') + (model.recommendations.length > 20 ? '<p class="insights-intro">Showing 20 of ' + model.recommendations.length + ' suggestions. Open the work queue to inspect all loaded stories.</p>' : '') + '</section><section class="insights-panel" aria-label="Activity and evidence timeline"><p class="eyebrow">Traceable delivery</p><h2>Activity &amp; evidence</h2><p class="insights-intro">Local actions and observed GitLab snapshots are separate evidence types. This is not stage-transition history. Dashboard action history and plan audit are bounded local records. Verification shows the latest recorded run.</p>' + (model.timeline.length ? '<ol class="insights-list insights-timeline">' + model.timeline.slice(0,50).map(item => '<li><span class="insights-kind">' + esc(item.kind) + '</span><h3><a href="' + esc(item.href) + '">' + esc(item.title) + '</a></h3>' + date(item.at) + '<p>' + esc(item.detail) + '</p></li>').join('') + '</ol>' : '<p>No dated activity is available from the loaded sources.</p>') + (model.timeline.length > 50 ? '<p class="insights-intro">Showing the latest 50 of ' + model.timeline.length + ' loaded records.</p>' : '') + '</section></div>' + model.notices.map(notice => '<p class="insights-notice">' + esc(notice) + '</p>').join('');
}
`;
