/** Explicit fixed-action controls. Navigation never starts a process. */
export const dashboardControlsCss = String.raw`
.action-console { margin-top:18px; }
.action-console .toolbar { align-items:center; }
.action-console label { display:flex; gap:9px; align-items:flex-start; font-size:12px; line-height:1.6; }
.action-console input[type=checkbox] { min-height:20px; flex-shrink:0; }
.action-console pre { max-height:300px; white-space:pre-wrap; overflow-wrap:anywhere; }
.action-job { padding:12px 0; border-top:1px solid var(--line); }
`;
export const dashboardControlsScript = String.raw`
async function renderActionConsole(host) {
  host.innerHTML = '<section class="action-console"><h2>Run a supervised action</h2><p>These buttons run a fixed Oflow command in this repository on the local server. Refresh contacts GitLab to read a new snapshot. No action here applies a GitLab change.</p><div class="toolbar"><button type="button" class="action primary" id="run-refresh">Refresh from GitLab</button><a class="action" href="#work">Open a story for context / assessment</a></div><label><input type="checkbox" id="allow-checks">I understand configured checks execute repository code locally and may change files or access the network.</label><p class="muted">Only use checks from a repository you trust. This runs the existing verification configuration, not arbitrary commands supplied by this page.</p><button type="button" class="action" id="run-checks" disabled>Run configured checks</button><p id="action-console-status" role="status" aria-live="polite"></p><div id="action-console-jobs"></div><button type="button" class="action" id="reload-jobs">Reload action results</button></section>';
  const get = (id) => host.querySelector('#'+id);
  let disposed = false; let timer = null; let submitting = false;
  const previousDispose = host.dispose;
  host.dispose = () => { disposed=true; if(timer) clearTimeout(timer); if(previousDispose) previousDispose(); };
  const state = (text) => { get('action-console-status').textContent=text; };
  async function reload() {
    try {
      const result=await api('/api/actions'); if(disposed) return;
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];
      const running=jobs.some((job)=>job.status==='running');
      get('run-refresh').disabled=running || submitting;
      get('run-checks').disabled=running || submitting || !get('allow-checks').checked;
      get('action-console-jobs').innerHTML=jobs.slice(0,10).map((job)=>'<div class="action-job"><strong>'+esc(job.action)+(job.story ? ' · #'+esc(job.story) : '')+'</strong> '+badge(job.status)+'<span class="muted">'+esc(when(job.startedAt))+'</span>'+(job.status==='running' ? '<button type="button" class="action" data-cancel-job="'+esc(job.id)+'">Cancel action</button>' : '')+(job.error ? '<p>'+esc(job.error)+'</p>' : '')+(job.result ? '<details><summary>Recorded result · '+esc(when(job.finishedAt))+'</summary><pre>'+esc(JSON.stringify(job.result,null,2))+'</pre></details>' : '')+'</div>').join('') || '<p class="muted">No dashboard actions recorded yet.</p>';
      get('action-console-jobs').querySelectorAll('[data-cancel-job]').forEach((button)=>button.addEventListener('click',async()=>{
        button.disabled=true;
        try { await api('/api/actions/'+encodeURIComponent(button.dataset.cancelJob)+'/cancel',{method:'POST'}); if(!disposed) {state('Cancellation requested. Any completed side effects from configured checks are not undone.'); await reload();} }
        catch(error){if(!disposed){state(error.message);button.disabled=false;}}
      }));
      if(timer) clearTimeout(timer);
      if(running) timer=setTimeout(()=>{if(!disposed) void reload();},1000);
    } catch(error) { if(!disposed) state('Action history unavailable: '+error.message); }
  }
  async function run(action) {
    submitting=true; get('run-refresh').disabled=true;get('run-checks').disabled=true;state('Starting '+action+'…');
    try {const job=await api('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});if(!disposed) state('Action '+job.status+'. Results appear below. After a refresh completes, reload local data to update the other views.');}
    catch(error){if(!disposed) state(error.message);}
    finally {submitting=false;if(!disposed) await reload();}
  }
  get('run-refresh').addEventListener('click',()=>{void run('refresh');});
  get('run-checks').addEventListener('click',()=>{if(get('allow-checks').checked) void run('verify-local');});
  get('allow-checks').addEventListener('change',()=>{void reload();});
  get('reload-jobs').addEventListener('click',()=>{void reload();});
  await reload();
}
`;
