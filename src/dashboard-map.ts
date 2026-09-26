/** Dependency-free, cache-only work map embedded by the dashboard shell. */
export const dashboardMapCss = String.raw`
.work-map { margin:0 0 20px; padding:22px; }
.flow-board[hidden] { display:none; }
.flow-board { display:flex; gap:12px; overflow:auto; padding:12px 0; max-height:580px; }
.flow-column { flex:0 0 260px; min-width:0; padding:14px; border:1px solid var(--line); border-radius:9px; background:#f1f5f1; overflow-wrap:anywhere; }
.flow-column h3 { font-size:14px; }
.flow-card { display:block; margin:10px 0; padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--text); text-decoration:none; overflow-wrap:anywhere; }
.flow-card small { display:block; color:var(--muted); margin:5px 0; }
.flow-card:hover,.flow-card:focus-visible { outline:2px solid var(--accent); }
.flow-policy { padding:14px; border:1px solid var(--line); border-radius:9px; margin:12px 0; }
.flow-policy textarea { min-height:75px; width:100%; resize:vertical; border:1px solid var(--line); border-radius:7px; padding:10px; background:var(--panel); color:var(--text); }
.flow-warning { color:#8a4311; font-weight:600; }
.flow-guidance { font-size:12px; white-space:pre-wrap; }
.map-announcement { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.map-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.map-heading h2 { font-size:23px; margin-bottom:6px; letter-spacing:-.7px; }
.map-heading p { margin:0; }
.map-controls { display:flex; flex-wrap:wrap; gap:12px; margin:20px 0 12px; }
.map-controls label { display:flex; flex-direction:column; gap:6px; font-size:12px; font-weight:600; flex:1 1 150px; min-width:0; }
.map-controls input,.map-controls select { width:100%; padding:10px; border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--text); min-height:42px; }
.map-stages { margin:18px 0; }
.map-stage-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
.map-stage-heading h3 { margin:0; font-size:14px; }
.map-stage-heading p { margin:0; font-size:12px; color:var(--muted); }
.map-stage-list { display:flex; flex-wrap:wrap; gap:8px; }
.map-stage { flex:1 1 120px; min-width:0; min-height:76px; padding:12px; text-align:left; border:1px solid var(--line); border-radius:9px; color:var(--text); background:var(--panel); }
.map-stage:hover { border-color:var(--accent); }
.map-stage[aria-pressed="true"] { border-color:var(--accent); background:#e8f6ed; box-shadow:inset 0 0 0 1px var(--accent); }
.map-stage small { display:block; font-size:10px; color:var(--muted); margin-bottom:7px; }
.map-stage strong { display:flex; align-items:baseline; justify-content:space-between; gap:10px; font-size:12px; overflow-wrap:anywhere; }
.map-stage-count { font-size:20px; font-variant-numeric:tabular-nums; color:var(--accent); }
.map-stage-other { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
.map-stage-other .map-stage { flex:0 1 220px; min-height:66px; }
.map-stage:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
.map-status { display:flex; flex-wrap:wrap; gap:8px 20px; justify-content:space-between; font-size:12px; margin:10px 0; color:var(--muted); }
.map-legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin:12px 0; }
.map-legend strong { color:var(--accent); }
.map-viewport { overflow:auto; max-height:580px; border:1px solid var(--line); border-radius:10px; background:#f1f5f1; overscroll-behavior:contain; }
.map-space { position:relative; }
.map-canvas { position:relative; transform-origin:top left; }
.map-lane { position:absolute; top:0; bottom:0; width:250px; border-right:1px solid var(--line); background:rgba(255,255,255,.38); }
.map-lane h3 { padding:18px 16px; margin:0; display:flex; justify-content:space-between; font-size:12px; letter-spacing:.2px; overflow-wrap:anywhere; max-height:52px; overflow:hidden; }
.map-lane h3 span { font-variant-numeric:tabular-nums; color:var(--muted); }
.map-node { position:absolute; width:220px; height:112px; border:1px solid #ccd8d0; border-radius:9px; padding:12px; text-align:left; background:var(--panel); color:var(--text); box-shadow:0 2px 3px #20312d05; z-index:2; display:flex; flex-direction:column; gap:6px; }
.map-node:hover { border-color:var(--accent); background:#f7fcf8; }
.map-node[aria-pressed="true"] { border:2px solid var(--accent); padding:11px; box-shadow:0 0 0 3px #087f6d1a; }
.map-node.connected { border-color:var(--accent); background:#edf8f1; }
.map-node.dimmed { opacity:.48; }
.map-node small { font-size:10px; color:var(--muted); display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.map-node strong { font-size:12px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.map-reference-lane { background:#e8edf2; border-right:2px dashed #c1cdd5; }
.map-reference { border-style:dashed; background:#f7f9fc; }
.map-edge.reference { stroke-dasharray:5 4; }
.map-edges { position:absolute; inset:0; pointer-events:none; z-index:1; overflow:visible; }
.map-edge { fill:none; stroke:#8b9d94; stroke-width:1.6; opacity:.65; }
.map-edge.active { stroke:var(--accent); stroke-width:2.5; opacity:1; }
.map-edge.dimmed { opacity:.15; }
.map-inspector { margin-top:16px; border-top:1px solid var(--line); padding-top:18px; overflow-wrap:anywhere; }
.map-inspector h3 { font-size:17px; }
.map-inspector-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; }
.map-relations { list-style:none; padding:0; margin:10px 0; display:flex; flex-wrap:wrap; gap:8px; }
.map-relation { border:1px solid var(--line); padding:8px 10px; border-radius:7px; background:var(--panel); color:var(--accent); text-align:left; max-width:100%; overflow-wrap:anywhere; }
.map-note { font-size:12px; margin:10px 0 0; }
.map-zoom { display:flex; gap:5px; align-items:center; flex-wrap:wrap; }
.map-zoom .action { min-width:40px; min-height:40px; }
@media(max-width:700px) { .work-map { padding:15px; } .map-inspector-grid { grid-template-columns:1fr; gap:12px; } .map-viewport { max-height:460px; } }
`;

export const dashboardMapScript = String.raw`
function mapCanonicalUrl(value) {
  if (!safeUrl(value)) return null;
  try { const url = new URL(value); url.hash = ''; url.pathname = url.pathname.replace(/\/+$/, '') || '/'; return url.href; } catch { return null; }
}
function buildWorkMap(data, options = {}) {
  const items = data.workItems || [];
  const boards = (data.planning || {}).boards || [];
  const board = boards.find((entry) => String(entry.id) === String(options.boardId)) || boards[0] || null;
  const lists = board ? (board.lists || []).map((list, index) => ({...list, index})).filter((list) => typeof list.label === 'string' && list.label.length).sort((a,b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.index - b.index) : [];
  const configuredFlow = lists.length > 0;
  const stages = configuredFlow ? lists.map((list,index) => ({id:'list-'+index,title:list.label,label:list.label})) : [
    {id:'backlog',title:'Backlog'}, {id:'ready',title:'Ready'}, {id:'progress',title:'In progress'}, {id:'review',title:'Review'}, {id:'done',title:'Done'}
  ];
  const lanes = [...stages, {id:'unmapped',title:'Unmapped / conflicting'}, {id:'closed',title:'Closed'}].map((lane) => ({...lane,nodes:[],count:0,cachedCount:0}));
  const allNodes = items.map((item,index) => {
    const labels = item.labels || [];
    const matches = stages.filter((stage) => configuredFlow ? labels.includes(stage.label) : labels.some((label) => [stage.title.toLowerCase(), 'status::'+stage.title.toLowerCase(), 'workflow::'+stage.title.toLowerCase()].includes(String(label).trim().toLowerCase())));
    const laneId = item.state === 'closed' ? 'closed' : matches.length === 1 ? matches[0].id : 'unmapped';
    return {id:'item-'+index,item,laneId};
  });
  allNodes.forEach((node) => lanes.find((lane) => lane.id === node.laneId).cachedCount++);
  const byUrl = new Map();
  allNodes.forEach((node) => { const url = mapCanonicalUrl(node.item.webUrl); if (url) byUrl.set(url, [...(byUrl.get(url) || []),node]); });
  const edges = []; const references = [];
  allNodes.forEach((node,index) => {
    if (!node.item.parent) return;
    const candidates = byUrl.get(mapCanonicalUrl(node.item.parent.webUrl)) || [];
    if (candidates.length === 1 && candidates[0].id !== node.id) edges.push({source:candidates[0].id,target:node.id});
    else references.push({id:'ref-'+index,parent:node.item.parent,childId:node.id});
  });
  const needle = String(options.search || '').trim().toLowerCase();
  const matchingNodes = allNodes.filter(({item}) => (!options.iteration || options.iteration === 'all' || item.iteration === options.iteration) &&
    [item.iid,item.title,...(item.labels || []),...(item.assignees || []),item.iteration,item.milestone].join(' ').toLowerCase().includes(needle));
  matchingNodes.forEach((node) => lanes.find((lane) => lane.id === node.laneId).count++);
  const stageId = lanes.some((lane) => lane.id === options.stageId) ? options.stageId : null;
  const nodes = matchingNodes.filter((node) => !stageId || node.laneId === stageId);
  nodes.forEach((node) => lanes.find((lane) => lane.id === node.laneId).nodes.push(node));
  const ids = new Set(nodes.map((node) => node.id));
  return {board,configuredFlow,lanes,stageId,matching:matchingNodes.length,nodes,allNodes,edges,references,total:items.length,visible:nodes.length,
    hiddenRelations:edges.filter((edge) => ids.has(edge.source) !== ids.has(edge.target)).length};
}
function validateStagePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const limit = value.limit === '' || value.limit == null ? null : (typeof value.limit === 'number' || typeof value.limit === 'string' && /^\d+$/.test(value.limit) ? Number(value.limit) : NaN);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)) return null;
  if (typeof value.entry !== 'string' || typeof value.exit !== 'string' || value.entry.length > 2000 || value.exit.length > 2000) return null;
  return {limit,entry:value.entry.trim(),exit:value.exit.trim()};
}
function renderWorkMap(host, data) {
  const boards = (data.planning || {}).boards || [];
  const iterations = [...new Set((data.workItems || []).map((item) => item.iteration).filter(Boolean))].sort();
  host.innerHTML = '<div class="map-heading"><div><div class="eyebrow">Plan together. Deliver in flow.</div><h2 id="map-title">Your work, connected</h2><p>Explore stories, follow parent connections, and find the next handoff.</p></div><a href="#work">Open work queue →</a></div>' +
    '<div class="map-controls"><label for="map-board">Flow source<select id="map-board">' + (boards.length ? boards.map((board) => '<option value="'+esc(board.id)+'">'+esc(board.name)+'</option>').join('') : '<option value="">Inferred label flow</option>') + '</select></label>' +
    '<label for="map-search">Find work<input type="search" id="map-search" placeholder="Story, label, or owner…" autocomplete="off"></label>' +
    '<label for="map-iteration">Iteration<select id="map-iteration"><option value="all">All cached iterations</option>'+iterations.map((iteration) => '<option value="'+esc(iteration)+'">'+esc(iteration)+'</option>').join('')+'</select></label></div>' +
    '<div class="map-zoom" role="group" aria-label="Work presentation"><button type="button" class="action" id="flow-mode-map" aria-pressed="true">Relationship map</button><button type="button" class="action" id="flow-mode-board" aria-pressed="false">Board view</button></div>' +
    '<p id="map-source" class="map-note"></p><div id="map-stages" class="map-stages" role="group" aria-label="Focus work by stage"></div><div class="map-status"><span id="map-count" role="status" aria-live="polite"></span><div class="map-zoom"><button type="button" id="map-zoom-out" class="action" aria-label="Zoom out work map">−</button><span id="map-zoom-level">100%</span><button type="button" id="map-zoom-in" class="action" aria-label="Zoom in work map">+</button><button type="button" id="map-reset" class="action">Reset view</button></div></div>' +
    '<div class="map-legend"><span><strong>Stages →</strong> Current label placement, not transition history</span><span><strong>↳ Arrows</strong> Parent → child, not dependencies or transition history · dashed: parent reference</span></div>' +
    '<div class="map-viewport" id="map-viewport" tabindex="0" role="region" aria-label="Work map. Scroll horizontally for more stages."><div class="map-space" id="map-space"><div class="map-canvas" id="map-canvas"></div></div></div>' +
    '<div id="flow-board" class="flow-board" role="region" aria-label="Cached work board" tabindex="0" hidden></div><details class="flow-policy"><summary>Stage policies · this browser only</summary><p class="map-note">Personal planning guidance, not GitLab configuration or enforced transition gates. WIP limits compare all cached items in this stage, before search and iteration filters; a bounded snapshot may undercount actual work.</p><div class="map-controls"><label for="flow-policy-stage">Stage<select id="flow-policy-stage"></select></label><label for="flow-policy-limit">WIP limit (optional)<input id="flow-policy-limit" type="number" min="1" max="10000" step="1" placeholder="No limit"></label></div><div class="map-controls"><label for="flow-policy-entry">Entry guidance<textarea id="flow-policy-entry" maxlength="2000"></textarea></label><label for="flow-policy-exit">Exit guidance<textarea id="flow-policy-exit" maxlength="2000"></textarea></label></div><div class="map-zoom"><button type="button" class="action" id="flow-policy-save">Save stage policy</button><button type="button" class="action" id="flow-policy-reset">Reset stage policy</button></div><p id="flow-policy-status" role="status" aria-live="polite"></p></details>' +
    '<p id="map-coverage" class="map-note"></p><span id="map-selection" class="map-announcement" role="status" aria-live="polite"></span><div id="map-inspector" class="map-inspector" role="region" aria-label="Selected map item"></div>';
  if (!host.querySelector) return;
  const get = (id) => host.querySelector('#'+id);
  const search = get('map-search'); const board = get('map-board'); const iteration = get('map-iteration');
  if (!search || !board || !iteration) return;
  let mode = 'map'; let selected = null; let stageId = null; let zoom = 1; let model; let width = 0; let height = 0;
  const policies = new Map();
  const projectKey = mapCanonicalUrl(data.project && data.project.webUrl);
  const policyKey = (lane) => 'oflow.stage-policy.v1:'+JSON.stringify([projectKey,model.board ? String(model.board.id) : 'inferred',lane.label || lane.title]);
  const policyFor = (lane) => {
    const key = policyKey(lane);
    if (!policies.has(key)) {
      let value = null;
      if (projectKey) { try { const stored = localStorage.getItem(key); if (stored) { value = validateStagePolicy(JSON.parse(stored)); if (!value) get('flow-policy-status').textContent='Invalid saved policy ignored. Save a new policy to replace it.'; } } catch { get('flow-policy-status').textContent='Browser storage unavailable; policies apply only while this view stays open.'; } }
      policies.set(key,value);
    }
    return policies.get(key);
  };
  const policySummary = (lane) => {
    const policy = policyFor(lane); if (!policy) return '';
    return (policy.limit === null ? '' : '<p class="'+(lane.cachedCount>policy.limit ? 'flow-warning' : 'map-note')+'">'+(lane.cachedCount>policy.limit ? 'WIP exceeded · ' : 'WIP · ')+lane.cachedCount+' cached / '+policy.limit+' limit</p>')+(policy.entry ? '<p class="flow-guidance"><strong>Entry:</strong> '+esc(policy.entry)+'</p>' : '')+(policy.exit ? '<p class="flow-guidance"><strong>Exit:</strong> '+esc(policy.exit)+'</p>' : '');
  };
  const loadPolicyEditor = () => {
    const lane = model.lanes.find((lane) => lane.id === get('flow-policy-stage').value);
    const policy = lane && policyFor(lane);
    get('flow-policy-limit').value = policy && policy.limit !== null ? String(policy.limit) : '';
    get('flow-policy-entry').value = policy ? policy.entry : '';
    get('flow-policy-exit').value = policy ? policy.exit : '';
  };
  const setZoom = () => {
    const canvas = get('map-canvas'); const space = get('map-space');
    if (!canvas.style || !space.style) return;
    canvas.style.transform = 'scale('+zoom+')'; space.style.width = width*zoom+'px'; space.style.height = height*zoom+'px';
    get('map-zoom-level').textContent = Math.round(zoom*100)+'%';
    get('map-zoom-out').disabled = zoom <= .6; get('map-zoom-in').disabled = zoom >= 1.4;
  };
  const select = (id) => { selected = id; draw(); };
  const relationButton = (node, label) => '<button class="map-relation" type="button" data-map-select="'+esc(node.id)+'">'+esc(label+' #'+node.item.iid+' '+node.item.title)+'</button>';
  function draw() {
    model = buildWorkMap(data,{boardId:board.value,search:search.value,iteration:iteration.value,stageId});
    stageId = model.stageId;
    get('map-viewport').hidden = mode !== 'map'; get('map-inspector').hidden = mode !== 'map'; get('flow-board').hidden = mode !== 'board';
    ['map','board'].forEach((value) => get('flow-mode-'+value).setAttribute('aria-pressed',String(mode === value)));
    ['map-zoom-out','map-zoom-in','map-zoom-level'].forEach((id) => { get(id).hidden = mode !== 'map'; });
    const policyStage = get('flow-policy-stage').value;
    const policyLanes = model.lanes.filter((lane) => !['unmapped','closed'].includes(lane.id));
    get('flow-policy-stage').innerHTML = policyLanes.map((lane) => '<option value="'+esc(lane.id)+'">'+esc(lane.title)+'</option>').join('');
    get('flow-policy-stage').value = policyLanes.some((lane) => lane.id === policyStage) ? policyStage : policyLanes[0].id;
    if (!projectKey) get('flow-policy-status').textContent='No project URL in this snapshot; policies apply only while this view stays open.';
    const orderedLanes = model.lanes.filter((lane) => !['unmapped','closed'].includes(lane.id));
    const stageButton = (lane, caption) => '<button type="button" class="map-stage" data-map-stage="'+esc(lane.id)+'" aria-pressed="'+(stageId === lane.id)+'" aria-label="'+esc('Focus '+lane.title+': '+lane.count+' matching work items')+'"><small>'+esc(caption)+'</small><strong>'+esc(lane.title)+'<span class="map-stage-count">'+lane.count+'</span></strong>'+(policyFor(lane) && policyFor(lane).limit !== null ? '<small class="'+(lane.cachedCount>policyFor(lane).limit ? 'flow-warning' : '')+'">'+(lane.cachedCount>policyFor(lane).limit ? 'WIP exceeded: ' : 'WIP: ')+lane.cachedCount+' cached / '+policyFor(lane).limit+'</small>' : '')+'</button>';
    get('map-stages').innerHTML = '<div class="map-stage-heading"><h3>Stage focus</h3><p>Counts follow your search and iteration. Select a stage to focus.</p></div><div class="map-stage-list"><button type="button" class="map-stage" data-map-stage="all" aria-pressed="'+(!stageId)+'"><small>Entire matching scope</small><strong>All stages<span class="map-stage-count">'+model.matching+'</span></strong></button>'+orderedLanes.map((lane,index) => stageButton(lane,(model.configuredFlow ? 'Board order ' : 'Inferred order ')+(index+1))).join('')+'</div><div class="map-stage-list map-stage-other">'+model.lanes.filter((lane) => ['unmapped','closed'].includes(lane.id)).map((lane) => stageButton(lane,lane.id === 'unmapped' ? 'Needs label alignment' : 'Separate item state')).join('')+'</div>';
    const visibleIds = new Set(model.nodes.map((node) => node.id));
    const referenceCards = []; const referenceKeys = new Map();
    const addReference = (id,parent,childId,hidden) => {
      const url = mapCanonicalUrl(parent.webUrl);
      const key = url || id;
      let card = referenceKeys.get(key);
      if (!card) { card = {id,parent,childIds:[],hidden}; referenceKeys.set(key,card); referenceCards.push(card); }
      if (!card.childIds.includes(childId)) card.childIds.push(childId);
      card.hidden = card.hidden || hidden;
    };
    model.references.filter((ref) => visibleIds.has(ref.childId)).forEach((ref) => addReference(ref.id,ref.parent,ref.childId,false));
    model.edges.filter((edge) => !visibleIds.has(edge.source) && visibleIds.has(edge.target)).forEach((edge) => {
      const parent = model.allNodes.find((entry) => entry.id === edge.source);
      addReference('hidden-'+parent.id,parent.item,edge.target,true);
    });
    const referenceEdges = referenceCards.flatMap((ref) => ref.childIds.map((childId) => ({source:ref.id,target:childId,reference:true})));
    const displayedEdges = [...model.edges,...referenceEdges];
    if (selected && !visibleIds.has(selected) && !referenceCards.some((ref) => ref.id === selected)) selected = null;
    const related = new Set([selected]);
    displayedEdges.forEach((edge) => { if (edge.source === selected || edge.target === selected) { related.add(edge.source); related.add(edge.target); } });
    get('map-source').textContent = model.configuredFlow ? 'Board label lists in configured position order. Open items matching multiple lists are conflicting; unlabeled or unmatched items are unmapped. Closed is a separate state, not evidence of completion.' : (model.board ? 'This board has no labeled lists. ' : '')+'Inferred convention, not a configured board: exact Backlog, Ready, In progress, Review, Done labels (also status:: / workflow:: prefixes; case-insensitive). Unmatched or conflicting labels stay unmapped. Closed is a separate state.';
    get('map-count').textContent = model.visible+' of '+model.total+' cached work items · '+(model.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).length+referenceEdges.length)+' visible connections · '+referenceCards.length+' parent references'+(stageId ? ' · Focus: '+model.lanes.find((lane) => lane.id === stageId).title : '');
    const unresolved = model.references.filter((ref) => visibleIds.has(ref.childId)).length;
    get('map-coverage').textContent = unresolved+' parent references outside the mapped cache or without a unique URL match · '+model.hiddenRelations+' connections cross the current filters. No parent recorded does not mean no relationship exists.'+(data.workItemsMayBeTruncated ? ' Snapshot may be truncated.' : ' Map covers this cached scope only.');
    const displayedLanes = stageId ? model.lanes.filter((lane) => lane.id === stageId) : model.lanes;
    get('flow-board').innerHTML = displayedLanes.map((lane) => '<section class="flow-column"><h3>'+esc(lane.title)+' · '+lane.nodes.length+'</h3>'+policySummary(lane)+(lane.nodes.length ? lane.nodes.map(({item}) => { const valid = Number.isSafeInteger(item.iid) && item.iid>0; return '<'+(valid ? 'a href="#story/'+item.iid+'"' : 'div')+' class="flow-card"><small>#'+esc(item.iid)+' · '+esc(item.state)+'</small><strong>'+esc(item.title)+'</strong><small>'+esc((item.assignees || []).join(', ') || 'Unassigned')+'</small>'+(item.parent ? '<small>Recorded parent: '+esc(item.parent.title || 'Untitled parent')+'</small>' : '')+(valid ? '<small>Open story workspace →</small></a>' : '</div>'); }).join('') : '<p class="muted">No matching cached items.</p>')+'</section>').join('');
    const railWidth = referenceCards.length ? 250 : 0;
    width = railWidth+displayedLanes.length*250; height = Math.max(310, 80 + Math.max(referenceCards.length,...displayedLanes.map((lane) => lane.nodes.length))*148);
    const positions = new Map();
    let markup = displayedLanes.map((lane,column) => {
      const left = railWidth+column*250;
      lane.nodes.forEach((node,row) => positions.set(node.id,{x:left+15,y:64+row*148}));
      return '<div class="map-lane" style="left:'+left+'px"><h3>'+esc(lane.title)+'<span>'+lane.nodes.length+'</span></h3></div>';
    }).join('');
    if (referenceCards.length) {
      markup += '<div class="map-lane map-reference-lane" style="left:0"><h3>Parent references<span>'+referenceCards.length+'</span></h3></div>';
      markup += referenceCards.map((ref,row) => {
        const pos = {x:15,y:64+row*148}; positions.set(ref.id,pos);
        const title = ref.parent.title || 'Untitled parent';
        const status = ref.hidden ? 'Hidden by filters' : 'Outside mapped cache / unmatched URL';
        return '<button type="button" class="map-node map-reference'+(selected && ref.id !== selected ? related.has(ref.id) ? ' connected' : ' dimmed' : '')+'" style="left:'+pos.x+'px;top:'+pos.y+'px" data-map-select="'+ref.id+'" aria-pressed="'+(selected === ref.id)+'" aria-label="'+esc('Parent reference: '+title+'; '+status)+'"><small>Parent reference · not a Scrum stage</small><strong>'+esc(title)+'</strong><small>'+esc(status)+' · '+ref.childIds.length+' children</small></button>';
      }).join('');
    }
    markup += model.nodes.map((node) => {
      const pos = positions.get(node.id); const item = node.item;
      return '<button type="button" class="map-node'+(selected && node.id !== selected ? related.has(node.id) ? ' connected' : ' dimmed' : '')+'" style="left:'+pos.x+'px;top:'+pos.y+'px" data-map-select="'+node.id+'" aria-pressed="'+(selected === node.id)+'" aria-label="'+esc('#'+item.iid+' '+item.title+'; '+model.lanes.find((lane) => lane.id === node.laneId).title)+'"><small>#'+esc(item.iid)+' · '+esc(item.state || 'State not recorded')+'</small><strong>'+esc(item.title)+'</strong><small>'+esc((item.assignees || []).join(', ') || 'Unassigned')+'</small></button>';
    }).join('');
    markup += '<svg class="map-edges" width="'+width+'" height="'+height+'" aria-hidden="true"><defs><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#087f6d"/></marker></defs>' +
      displayedEdges.map((edge) => {
        const from = positions.get(edge.source), to = positions.get(edge.target); if (!from || !to) return '';
        // Route through column-side gutters and the top gutter, never across card content.
        const forward = from.x <= to.x;
        const ax = from.x+(forward?220:0), bx = to.x+(forward?0:220);
        const ay = from.y+56, by = to.y+56;
        const sourceGutter = ax+(forward?10:-10), targetGutter = bx+(forward?-10:10);
        const rowGutter = 52;
        const path = from.x === to.x ? 'M '+ax+' '+ay+' H '+sourceGutter+' V '+by+' H '+ax :
          'M '+ax+' '+ay+' H '+sourceGutter+' V '+rowGutter+' H '+targetGutter+' V '+by+' H '+bx;
        return '<path class="map-edge'+(edge.reference ? ' reference' : '')+(selected ? edge.source === selected || edge.target === selected ? ' active' : ' dimmed' : '')+'" d="'+path+'" marker-end="url(#map-arrow)"/>';
      }).join('')+'</svg>';
    const canvas = get('map-canvas');
    canvas.innerHTML = model.nodes.length ? markup : empty(model.total ? 'No matching work items' : 'No cached work items', model.total ? 'Clear search or choose another iteration.' : 'Run oflow sync --refresh in your repository terminal to build the map.');
    if (canvas.style) { canvas.style.width = model.nodes.length ? width+'px' : '100%'; canvas.style.height = model.nodes.length ? height+'px' : 'auto'; }
    if (!model.nodes.length) { width=0; height=170; }
    setZoom();
    if (!model.nodes.length && get('map-space').style) get('map-space').style.width='100%';
    const node = model.nodes.find((entry) => entry.id === selected);
    const inspector = get('map-inspector');
    const reference = referenceCards.find((entry) => entry.id === selected);
    if (reference) inspector.innerHTML = '<div class="eyebrow">Parent reference · not a Scrum stage</div><h3>'+link(reference.parent.title || 'Untitled parent',reference.parent.webUrl)+'</h3><p class="muted">'+(reference.hidden ? 'This parent work item is hidden by the current filters.' : 'This parent is outside the mapped cache or its URL does not uniquely match a cached work item.')+' It may be an epic or another work item. This card shows recorded parentage, not a dependency or workflow transition.</p><h4>Visible children</h4><div class="map-relations">'+reference.childIds.map((id) => relationButton(model.nodes.find((entry) => entry.id === id),'Child')).join('')+'</div>';
    else if (!node) inspector.innerHTML = '<h3>Select a work item</h3><p class="muted">Click a card or use Tab and Enter to inspect its parent and children. Work items also offer agent commands. Related cards and connections will be highlighted.</p>';
    else {
      const item = node.item;
      const parentEdge = model.edges.find((edge) => edge.target === node.id);
      const children = model.edges.filter((edge) => edge.source === node.id).map((edge) => model.allNodes.find((entry) => entry.id === edge.target));
      const relation = (entry,label) => visibleIds.has(entry.id) ? relationButton(entry,label) : '<span class="map-relation">'+esc(label+' #'+entry.item.iid+' '+entry.item.title)+' · hidden by filters '+link('Open in GitLab',entry.item.webUrl)+'</span>';
      const parentReference = referenceCards.find((ref) => ref.childIds.includes(node.id));
      const parentMarkup = parentReference ? '<button class="map-relation" type="button" data-map-select="'+parentReference.id+'">'+esc('Parent reference · '+(parentReference.parent.title || 'Untitled parent')+(parentReference.hidden ? ' · hidden by filters' : ' · outside mapped cache / unmatched URL'))+'</button>' : parentEdge ? relation(model.allNodes.find((entry) => entry.id === parentEdge.source),'Parent') : item.parent ? '<span class="map-relation">Parent reference · '+link(item.parent.title || 'Untitled parent',item.parent.webUrl)+' · outside mapped cache / unmatched URL</span>' : '<span class="muted">No parent recorded in this snapshot.</span>';
      inspector.innerHTML = '<div class="map-inspector-grid"><div><div class="eyebrow">Selected work item</div><h3>'+link('#'+item.iid+' '+item.title,item.webUrl)+'</h3><p>'+esc(model.lanes.find((lane) => lane.id === node.laneId).title)+' · '+esc(item.state || 'State not recorded')+'<br>Owners: '+esc((item.assignees || []).join(', ') || 'Unassigned')+'<br>Iteration: '+esc(item.iteration || 'Not set')+' · Milestone: '+esc(item.milestone || 'Not set')+'<br>Labels: '+esc((item.labels || []).join(', ') || 'None')+'</p><h4>Recorded connections</h4><div class="map-relations">'+parentMarkup+'</div><div class="map-relations">'+(children.length ? children.map((child) => relation(child,'Child')).join('') : '<span class="muted">No children found in this cached scope.</span>')+'</div></div><div><h3>Hand off to your agent</h3><p class="muted">Copy only. Run in your repository terminal.</p>'+(Number.isSafeInteger(item.iid) && item.iid>0 ? '<p><a class="action" href="#story/'+item.iid+'">Open story workspace →</a></p><p><strong>Story context</strong> gives your agent the story and acceptance criteria before it starts.</p>'+command('oflow context --story '+item.iid+' --json','Copy story context command')+'<p><strong>Assess story</strong> compares acceptance criteria with local work and recorded verification evidence to highlight gaps.</p>'+command('oflow assess --story '+item.iid+' --json','Copy assessment command') : '<p>No valid story number for CLI commands.</p>')+'</div></div>';
    }
    if (host.querySelectorAll) host.querySelectorAll('[data-map-select]').forEach((button) => button.addEventListener('click', () => { const id=button.dataset.mapSelect; select(id); const replacement=host.querySelector('.map-node[data-map-select="'+id+'"]'); if (replacement && replacement.focus) { replacement.focus({preventScroll:true}); if (button.matches && button.matches('.map-relation') && replacement.scrollIntoView) replacement.scrollIntoView({block:'nearest',inline:'nearest'}); }
      const selectedItem = model.nodes.find((entry) => entry.id === id);
      get('map-selection').textContent = selectedItem ? 'Selected #'+selectedItem.item.iid+' '+selectedItem.item.title+'. Details below the map.' : 'Selected parent reference. Details below the map.'; }));
  }
  get('map-stages').addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-map-stage]');
    if (!button || !get('map-stages').contains(button)) return;
    stageId = button.dataset.mapStage === 'all' ? null : button.dataset.mapStage;
    draw();
    get('map-viewport').scrollLeft=0; get('map-viewport').scrollTop=0;
    const replacement = get('map-stages').querySelector('[data-map-stage="'+(stageId || 'all')+'"]');
    if (replacement && replacement.focus) replacement.focus({preventScroll:true});
  });
  ['map','board'].forEach((value) => get('flow-mode-'+value).addEventListener('click',()=>{mode=value;draw();}));
  get('flow-policy-stage').addEventListener('change',loadPolicyEditor);
  const savePolicy = (reset) => {
    const lane = model.lanes.find((lane) => lane.id === get('flow-policy-stage').value);
    if (!lane || ['unmapped','closed'].includes(lane.id)) return;
    const policy = reset ? null : validateStagePolicy({limit:get('flow-policy-limit').value,entry:get('flow-policy-entry').value,exit:get('flow-policy-exit').value});
    if (!reset && !policy) { get('flow-policy-status').textContent='Use a whole-number WIP limit from 1 to 10000 or leave it blank. Entry and exit guidance must each be at most 2000 characters.'; return; }
    const key=policyKey(lane); policies.set(key,policy);
    let persisted=false;
    if (projectKey) { try { if (reset) localStorage.removeItem(key); else localStorage.setItem(key,JSON.stringify(policy)); persisted=true; } catch {} }
    draw(); loadPolicyEditor();
    get('flow-policy-status').textContent=(reset ? 'Policy reset. ' : 'Policy saved. ')+(persisted ? 'Stored only in this browser for this project and board.' : 'Browser persistence unavailable; applies only while this view stays open.');
  };
  get('flow-policy-save').addEventListener('click',()=>savePolicy(false)); get('flow-policy-reset').addEventListener('click',()=>savePolicy(true));
  search.addEventListener('input',draw); board.addEventListener('change',()=>{stageId=null;selected=null;draw();loadPolicyEditor();get('map-viewport').scrollLeft=0;}); iteration.addEventListener('change',draw);
  get('map-zoom-in').addEventListener('click',()=>{zoom=Math.min(1.4,Math.round((zoom+.1)*10)/10);setZoom();});
  get('map-zoom-out').addEventListener('click',()=>{zoom=Math.max(.6,Math.round((zoom-.1)*10)/10);setZoom();});
  get('map-reset').addEventListener('click',()=>{zoom=1;selected=null;stageId=null;draw();get('map-viewport').scrollLeft=0;get('map-viewport').scrollTop=0;});
  draw(); loadPolicyEditor();
}
`;
