import { test } from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import { dashboardViewHtml } from "../dist/dashboard-view.js";

// Exercise the exact browser program served by the dashboard, without network.
function harness(storage = new Map(), storageBlocked = false) {
  const elements = new Map();
  let buttons = [];
  const scrolls = [];
  const element = () => ({
    innerHTML: "", textContent: "", value: "", dataset: {}, style: {},
    listeners: new Map(), children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    querySelector(selector) { return get(selector.slice(1)); },
    querySelectorAll(selector) {
      if (selector !== '[data-map-select]') return [];
      const markup = [...elements.values()].map((entry) => entry.innerHTML).join('');
      buttons = [...markup.matchAll(/<button[^>]*data-map-select="([^"]+)"[^>]*>/g)].map((match) => {
        const button = element();
        button.dataset.mapSelect = match[1];
        button.matches = (selector) => selector === ".map-relation" && /class="map-relation"/.test(match[0]);
        return button;
      });
      return buttons;
    },
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    contains() { return true; }, focus() {},
    scrollIntoView(options) { scrolls.push(options); },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [], createElement: element, addEventListener() {} },
    location: { hash: "" }, window: { addEventListener() {} }, navigator: {},
    URL, console, setTimeout, clearTimeout,
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key,value) { if (storageBlocked) throw new Error('blocked'); storage.set(key,value); },
      removeItem(key) { if (storageBlocked) throw new Error('blocked'); storage.delete(key); },
    },
    fetch: async (...args) => { requests.push(args); throw new Error("Map must use cached data only"); },
  });
  const script = dashboardViewHtml().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "served browser script exists");
  new vm.Script(script.split("window.addEventListener('hashchange'")[0]).runInContext(context);
  const select = (id, relation = false) => {
    const button = buttons.find((entry) => entry.dataset.mapSelect === id && (!relation || entry.matches(".map-relation")));
    assert.ok(button, `selectable node ${id}`);
    button.listeners.get("click")();
  };
  return { get, requests, select, scrolls, ...vm.runInContext("({buildWorkMap, renderWorkMap, validateStagePolicy})", context) };
}

const issueUrl = (iid, project = "demo") => `https://gitlab.example.test/team/${project}/-/issues/${iid}`;
const item = (iid, fields = {}) => ({ iid, title: `Story ${iid}`, state: "opened", labels: [], assignees: [], webUrl: issueUrl(iid), ...fields });
const data = (workItems = [], boards = []) => ({ workItems, planning: { boards }, iterations: [] });
const laneTitles = (model) => Array.from(model.lanes, (lane) => lane.title);
const nodeLane = (model, iid) => model.nodes.find((node) => node.item.iid === iid)?.laneId;
const laneFor = (model, iid) => model.lanes.find((lane) => lane.id === nodeLane(model, iid))?.title;

const board = { id: 7, name: "Delivery", lists: [
  { id: 72, label: "Review queue", position: 2 },
  { id: 73, label: "Later", position: null },
  { id: 71, label: "Building", position: 0 },
] };

test("work map follows configured board positions rather than assuming scrum labels", () => {
  const model = harness().buildWorkMap(data([item(1, { labels: ["Building"] }), item(2, { labels: ["Review queue"] })], [board]), { boardId: 7 });
  assert.deepEqual(laneTitles(model).slice(0, 3), ["Building", "Review queue", "Later"]);
  assert.equal(laneFor(model, 1), "Building");
  assert.equal(laneFor(model, 2), "Review queue");
});

test("closed state takes precedence over stale workflow labels", () => {
  const model = harness().buildWorkMap(data([item(1, { state: "closed", labels: ["Building"] })], [board]), { boardId: 7 });
  assert.equal(nodeLane(model, 1), "closed");
});

test("conflicting board labels and unrelated labels remain explicitly unmapped", () => {
  const model = harness().buildWorkMap(data([
    item(1, { labels: ["Building", "Review queue"] }),
    item(2, { labels: ["frontend"] }),
  ], [board]), { boardId: 7 });
  assert.equal(nodeLane(model, 1), "unmapped");
  assert.equal(nodeLane(model, 2), "unmapped");
});

test("fallback flow uses exact conventional aliases, not substring guesses", () => {
  const model = harness().buildWorkMap(data([
    item(1, { labels: [" WORKFLOW::In Progress "] }),
    item(2, { labels: ["review needed someday"] }),
    item(3, { labels: ["ready", "review"] }),
    item(4, { labels: ["status::done"] }),
  ]), {});
  assert.equal(nodeLane(model, 1), "progress");
  assert.equal(nodeLane(model, 2), "unmapped");
  assert.equal(nodeLane(model, 3), "unmapped");
  assert.equal(nodeLane(model, 4), "done");
});

test("search and iteration filters intersect without discarding unfiltered totals", () => {
  const model = harness().buildWorkMap(data([
    item(1, { title: "Build search", iteration: "Sprint A" }),
    item(2, { title: "Build search", iteration: "Sprint B" }),
    item(3, { title: "Fix delivery", iteration: "Sprint A" }),
  ]), { search: " SEARCH ", iteration: "Sprint A" });
  assert.deepEqual(Array.from(model.nodes, (node) => node.item.iid), [1]);
  assert.equal(model.total, 3);
  assert.equal(model.visible, 1);
});

test("parent links use canonical URLs even when issue IDs collide across projects", () => {
  const model = harness().buildWorkMap(data([
    item(7), item(7, { webUrl: issueUrl(7, "other") }),
    item(8, { parent: { iid: 7, title: "Other parent", webUrl: issueUrl(7, "other") } }),
  ]), {});
  const parent = model.nodes.find((node) => node.item.webUrl === issueUrl(7, "other"));
  const child = model.nodes.find((node) => node.item.iid === 8);
  assert.deepEqual(Array.from(model.edges, (edge) => [edge.source, edge.target]), [[parent.id, child.id]]);
});

test("an epic sharing an issue ID stays an external parent reference", () => {
  const parent = { iid: 7, title: "Epic parent", webUrl: "https://gitlab.example.test/groups/team/-/epics/7" };
  const model = harness().buildWorkMap(data([item(7), item(8, { parent })]), {});
  assert.equal(model.edges.length, 0);
  assert.equal(model.references.length, 1);
  assert.equal(model.references[0].parent.webUrl, parent.webUrl);
});

test("parents absent from the snapshot remain references rather than invented work items", () => {
  const model = harness().buildWorkMap(data([item(1, { parent: { iid: 99, title: "Not cached", webUrl: issueUrl(99) } })]), {});
  assert.equal(model.nodes.length, 1);
  assert.equal(model.references.length, 1);
  assert.equal(model.edges.length, 0);
});

test("parents without URLs are never merged merely because their IDs match", () => {
  const model = harness().buildWorkMap(data([
    item(7), item(8, { parent: { iid: 7, title: "First unknown parent" } }),
    item(9, { parent: { iid: 7, title: "Second unknown parent" } }),
  ]), {});
  assert.equal(model.edges.length, 0);
  assert.equal(model.references.length, 2);
  assert.equal(new Set(model.references.map((reference) => reference.id)).size, 2);
});

test("cyclic and self-parented data stays finite and does not invent additional nodes", () => {
  const model = harness().buildWorkMap(data([
    item(1, { parent: { iid: 2, webUrl: issueUrl(2) } }),
    item(2, { parent: { iid: 1, webUrl: issueUrl(1) } }),
    item(3, { parent: { iid: 3, webUrl: issueUrl(3) } }),
  ]), {});
  assert.equal(model.nodes.length, 3);
  assert.equal(new Set(model.nodes.map((node) => node.id)).size, 3);
  assert.ok(model.edges.length <= 3);
});

test("empty and missing cached fields produce a finite empty map", () => {
  const { buildWorkMap } = harness();
  for (const snapshot of [{}, data()]) {
    const model = buildWorkMap(snapshot, {});
    assert.equal(model.nodes.length, 0);
    assert.equal(model.edges.length, 0);
    assert.equal(model.references.length, 0);
    assert.equal(model.total, 0);
  }
});

test("duplicate cached URLs are ambiguous and do not choose an arbitrary parent", () => {
  const model = harness().buildWorkMap(data([
    item(7), item(7, { title: "Duplicate cached record" }),
    item(8, { parent: { iid: 7, title: "Ambiguous parent", webUrl: issueUrl(7) } }),
  ]), {});
  assert.equal(model.edges.length, 0);
  assert.equal(model.references.length, 1);
});

test("fallback map discloses inferred stages and relationship limits", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([item(1)]));
  assert.match(page.get("map-source").textContent, /Inferred convention, not a configured board/);
  assert.match(page.get("host").innerHTML, /not dependencies or transition history/);
  assert.match(page.get("map-coverage").textContent, /cached scope only/);
});

test("map search and iteration controls redraw cached items without HTTP requests", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([
    item(1, { title: "Build search", iteration: "Sprint A" }),
    item(2, { title: "Build search", iteration: "Sprint B" }),
    item(3, { title: "Delivery", iteration: "Sprint A" }),
  ]));
  assert.match(page.get("map-count").textContent, /^3 of 3/);
  page.get("map-search").value = "search";
  page.get("map-search").listeners.get("input")();
  assert.match(page.get("map-count").textContent, /^2 of 3/);
  page.get("map-iteration").value = "Sprint A";
  page.get("map-iteration").listeners.get("change")();
  assert.match(page.get("map-count").textContent, /^1 of 3/);
  assert.doesNotMatch(page.get("map-canvas").innerHTML, /Delivery/);
  assert.deepEqual(page.requests, []);
});

test("selecting a child exposes the recorded parent but never invents epic CLI commands", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([item(8, { parent: {
    iid: 999, title: "Roadmap epic", webUrl: "https://gitlab.example.test/groups/team/-/epics/999",
  } })]));
  page.select("item-0");
  const inspector = page.get("map-inspector").innerHTML;
  assert.match(inspector, /Roadmap epic/);
  assert.match(inspector, /Parent reference/);
  assert.match(inspector, /oflow context --story 8 --json/);
  assert.doesNotMatch(inspector, /--story 999/);
  assert.match(inspector, /data-map-select="ref-/);
  page.select("ref-0");
  assert.match(page.get("map-inspector").innerHTML, /Visible children/);
  assert.doesNotMatch(page.get("map-inspector").innerHTML, /data-copy|--story/);
  assert.deepEqual(page.requests, []);
});

test("selection highlights connected nodes and follows a cached parent", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([
    item(1, { title: "Parent story" }),
    item(2, { parent: { iid: 1, title: "Parent story", webUrl: issueUrl(1) } }),
    item(3, { title: "Unrelated" }),
  ]));
  page.select("item-1");
  assert.match(page.get("map-canvas").innerHTML, /class="map-node connected"/);
  assert.match(page.get("map-canvas").innerHTML, /class="map-node dimmed"/);
  assert.match(page.get("map-canvas").innerHTML, /class="map-edge active"/);
  assert.match(page.get("map-inspector").innerHTML, /Parent #1 Parent story/);
  page.select("item-0");
  assert.match(page.get("map-inspector").innerHTML, /Child #2 Story 2/);
});

test("filtering out a parent discloses hidden connections instead of dropping evidence", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([
    item(1, { title: "Parent story" }),
    item(2, { title: "Child story", parent: { iid: 1, title: "Parent story", webUrl: issueUrl(1) } }),
  ]));
  page.get("map-search").value = "Child";
  page.get("map-search").listeners.get("input")();
  page.select("item-1");
  assert.match(page.get("map-coverage").textContent, /1 connections cross the current filters/);
  assert.match(page.get("map-inspector").innerHTML, /Parent reference.*Parent story.*hidden by filters/);
  assert.match(page.get("map-canvas").innerHTML, /class="map-edge reference active"/);
  assert.match(page.get("map-canvas").innerHTML, /Hidden by filters/);
});

test("hostile cached strings remain escaped in cards, board options, and inspector", () => {
  const page = harness();
  const hostile = '<img src=x onerror="alert(1)">';
  page.renderWorkMap(page.get("host"), data([item(1, {
    title: hostile, labels: [hostile], assignees: [hostile], iteration: hostile,
    webUrl: "javascript:alert(1)", parent: { title: hostile, webUrl: "javascript:alert(1)" },
  })], [{ id: 1, name: hostile, lists: [{ label: hostile, position: 0 }] }]));
  page.select("item-0");
  for (const id of ["host", "map-canvas", "map-inspector"]) {
    const output = page.get(id).innerHTML;
    assert.match(output, /&lt;img/);
    assert.doesNotMatch(output, /<img|href="javascript:/);
  }
});

test("zoom is bounded and resetting clears selection and restores scale", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([item(1)]));
  page.select("item-0");
  for (let i = 0; i < 20; i++) page.get("map-zoom-in").listeners.get("click")();
  assert.equal(page.get("map-zoom-level").textContent, "140%");
  assert.equal(page.get("map-zoom-in").disabled, true);
  for (let i = 0; i < 20; i++) page.get("map-zoom-out").listeners.get("click")();
  assert.equal(page.get("map-zoom-level").textContent, "60%");
  assert.equal(page.get("map-zoom-out").disabled, true);
  page.get("map-reset").listeners.get("click")();
  assert.equal(page.get("map-zoom-level").textContent, "100%");
  assert.match(page.get("map-inspector").innerHTML, /Select a work item/);
  assert.equal(page.get("map-viewport").scrollLeft, 0);
  assert.deepEqual(page.requests, []);
});


test("a board with no labeled lists falls back to disclosed conventional stages", () => {
  const page = harness();
  const snapshot = data([item(1, { labels: ["Ready"] })], [{ id: 1, name: "Empty board", lists: [{ label: null, position: 0 }] }]);
  const model = page.buildWorkMap(snapshot, {});
  assert.equal(model.configuredFlow, false);
  assert.equal(laneFor(model, 1), "Ready");
  page.renderWorkMap(page.get("host"), snapshot);
  assert.match(page.get("map-source").textContent, /board has no labeled lists.*Inferred convention/);
});

// An empty board still has to render: the inferred convention supplies the
// lanes, so the stage-policy selector always has something to select. This
// pins that the fallback applies at zero items, not only with a work item
// present -- the earlier case covered the latter.
test("a board with no items still renders inferred stages", () => {
  const page = harness();
  const snapshot = data([], [{ id: 1, name: "Empty board", lists: [{ label: null, position: 0 }] }]);
  const model = page.buildWorkMap(snapshot, {});
  const policyLanes = model.lanes.filter((lane) => !["unmapped", "closed"].includes(lane.id));
  assert.ok(policyLanes.length > 0, "inferred convention must supply a lane to select");
  // A board whose only list label is unconventional still contributes a
  // configured lane, so the policy selector keeps a target. The item follows
  // that lane rather than `unmapped`, because its label does match it.
  const unmatched = data(
    [item(1, { labels: ["Zzz-unmatched"] })],
    [{ id: 1, name: "B", lists: [{ label: "Zzz-unmatched", position: 0 }] }],
  );
  assert.doesNotThrow(() => page.renderWorkMap(page.get("host"), unmatched));
  assert.equal(laneFor(page.buildWorkMap(unmatched, {}), 1), "Zzz-unmatched");
  assert.doesNotThrow(() => page.renderWorkMap(page.get("host"), snapshot));
  assert.equal(page.get("flow-policy-stage").value, policyLanes[0].id);
});

test("shared external parent URLs produce one reference card and multiple connectors", () => {
  const page = harness();
  const parent = { title: "Roadmap epic", webUrl: "https://gitlab.example.test/groups/team/-/epics/9" };
  page.renderWorkMap(page.get("host"), data([item(1, { parent }), item(2, { parent: { ...parent, webUrl: parent.webUrl + "/#details" } })]));
  const canvas = page.get("map-canvas").innerHTML;
  assert.equal((canvas.match(/class="map-node map-reference"/g) || []).length, 1);
  assert.equal((canvas.match(/class="map-edge reference"/g) || []).length, 2);
  page.select("ref-0");
  assert.match(page.get("map-inspector").innerHTML, /Child #1/);
  assert.match(page.get("map-inspector").innerHTML, /Child #2/);
  assert.doesNotMatch(page.get("map-inspector").innerHTML, /data-copy/);
});

test("same-named parent references without URLs remain separate on the canvas", () => {
  const page = harness();
  const parent = { iid: 9, title: "Unknown parent", webUrl: null };
  page.renderWorkMap(page.get("host"), data([item(1, { parent }), item(2, { parent })]));
  assert.equal((page.get("map-canvas").innerHTML.match(/class="map-node map-reference"/g) || []).length, 2);
});

test("board selection changes label lanes without any HTTP requests", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([item(1, { labels: ["Ready"] })], [
    {id: 1, name: "First", lists: [{ label: "Ready", position: 0 }]},
    {id: 2, name: "Second", lists: [{ label: "Building", position: 0 }]},
  ]));
  page.get("map-board").value = "2";
  page.get("map-board").listeners.get("change")();
  page.select("item-0");
  assert.match(page.get("map-inspector").innerHTML, /Unmapped \/ conflicting/);
  assert.deepEqual(page.requests, []);
});


test("relationship navigation reveals the target while ordinary card selection preserves scroll", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([
    item(1), item(2, { parent: { title: "Story 1", iid: 1, webUrl: issueUrl(1) } }),
  ]));
  page.select("item-1");
  assert.equal(page.scrolls.length, 0);
  page.select("item-0", true);
  assert.equal(page.scrolls.length, 1);
  assert.equal(page.scrolls[0].inline, "nearest");
  assert.match(page.get("map-selection").textContent, /Selected #1 Story 1/);
});

test("stage focus preserves search/iteration counts and recorded cross-stage relationships", () => {
  const snapshot = data([
    item(1, { labels: ["Ready"], iteration: "Sprint A" }),
    item(2, { labels: ["Review"], iteration: "Sprint A", parent: { iid: 1, webUrl: issueUrl(1) } }),
    item(3, { labels: ["Review"], iteration: "Sprint B" }),
  ]);
  const model = harness().buildWorkMap(snapshot, { iteration: "Sprint A", stageId: "review" });
  assert.equal(model.matching, 2);
  assert.equal(model.visible, 1);
  assert.equal(model.total, 3);
  assert.equal(model.lanes.find((lane) => lane.id === "ready").count, 1);
  assert.equal(model.lanes.find((lane) => lane.id === "review").count, 1);
  assert.equal(model.hiddenRelations, 1);
  assert.equal(model.edges.length, 1);
  assert.equal(harness().buildWorkMap(snapshot, { stageId: "unknown" }).visible, 3);
});

function focusStage(page, stageId) {
  const button = { dataset: { mapStage: stageId } };
  page.get("map-stages").listeners.get("click")({ target: { closest: () => button } });
}

test("clickable stage navigator separates exceptions and preserves filtered parent context", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([
    item(1, { title: "Parent story", labels: ["Ready"] }),
    item(2, { labels: ["Review"], parent: { iid: 1, title: "Parent story", webUrl: issueUrl(1) } }),
  ]));
  assert.match(page.get("map-stages").innerHTML, /map-stage-other.*Needs label alignment.*Separate item state/);
  focusStage(page, "review");
  assert.match(page.get("map-stages").innerHTML, /data-map-stage="review" aria-pressed="true"/);
  assert.match(page.get("map-stages").innerHTML, /Focus Ready: 1 matching work items/);
  assert.match(page.get("map-count").textContent, /^1 of 2.*Focus: Review/);
  assert.match(page.get("map-canvas").innerHTML, /Hidden by filters/);
  assert.equal((page.get("map-canvas").innerHTML.match(/class="map-lane"/g) || []).length, 1);
  page.select("item-1");
  assert.match(page.get("map-inspector").innerHTML, /Parent story.*hidden by filters/);
  focusStage(page, "all");
  assert.match(page.get("map-count").textContent, /^2 of 2/);
  assert.deepEqual(page.requests, []);
});

test("empty stage focus remains selected and reset and board changes clear it", () => {
  const page = harness();
  page.renderWorkMap(page.get("host"), data([item(1, { labels: ["Ready"], iteration: "Sprint A" })]));
  focusStage(page, "review");
  assert.match(page.get("map-count").textContent, /^0 of 1/);
  assert.match(page.get("map-stages").innerHTML, /data-map-stage="review" aria-pressed="true"/);
  page.get("map-reset").listeners.get("click")();
  assert.match(page.get("map-count").textContent, /^1 of 1/);
  assert.match(page.get("map-stages").innerHTML, /data-map-stage="all" aria-pressed="true"/);
  focusStage(page, "review");
  page.get("map-board").listeners.get("change")();
  assert.match(page.get("map-count").textContent, /^1 of 1/);
});

test("stage navigator escapes cached labels and count scope follows search", () => {
  const page = harness();
  const label = '<img src=x onerror="alert(1)">';
  page.renderWorkMap(page.get("host"), data([item(1, { title: "Keep", labels: [label] }), item(2, { labels: [label] })], [
    { id: 1, name: "Flow", lists: [{ label, position: 0 }] },
  ]));
  focusStage(page, "list-0");
  page.get("map-search").value = "Keep";
  page.get("map-search").listeners.get("input")();
  assert.match(page.get("map-stages").innerHTML, /&lt;img/);
  assert.doesNotMatch(page.get("map-stages").innerHTML, /<img/);
  assert.match(page.get("map-stages").innerHTML, /1 matching work items/);
  assert.match(page.get("map-count").textContent, /^1 of 2/);
});

const click = (page,id) => page.get(id).listeners.get('click')();
const policySnapshot = (boards = []) => ({...data([item(1,{labels:['Ready']}),item(2,{labels:['Ready']})],boards),project:{webUrl:'https://gitlab.example.test/team/demo'}});
function savePolicy(page, {stage='ready',limit='1',entry='Story understood',exit='Evidence attached'} = {}) {
  page.get('flow-policy-stage').value=stage;
  page.get('flow-policy-limit').value=limit;
  page.get('flow-policy-entry').value=entry;
  page.get('flow-policy-exit').value=exit;
  click(page,'flow-policy-save');
}

test('board shares stage, search and iteration filters and uses safe workspace routes',()=>{
  const page=harness();page.renderWorkMap(page.get('host'),data([item(1,{labels:['Ready'],iteration:'A'}),item(2,{labels:['Review'],iteration:'B'}),item(-3)]));
  assert.equal(page.get('flow-board').hidden,true);
  click(page,'flow-mode-board');
  assert.equal(page.get('map-viewport').hidden,true);
  assert.equal(page.get('flow-mode-board')['aria-pressed'],'true');
  assert.match(page.get('flow-board').innerHTML,/href="#story\/1"/);
  assert.doesNotMatch(page.get('flow-board').innerHTML,/href="#story\/-3"/);
  focusStage(page,'ready');
  page.get('map-iteration').value='A';page.get('map-iteration').listeners.get('change')();
  assert.doesNotMatch(page.get('flow-board').innerHTML,/#story\/2/);
  click(page,'flow-mode-map');page.select('item-0');
  assert.match(page.get('map-inspector').innerHTML,/#story\/1/);
  assert.match(page.get('map-count').textContent,/Focus: Ready/);
  assert.equal(page.requests.length,0);
});

test('WIP policies use all cached stage items and browser-only persistence, not filtered counts',()=>{
  const storage=new Map(),page=harness(storage);page.renderWorkMap(page.get('host'),policySnapshot());
  assert.doesNotMatch(page.get('map-stages').innerHTML,/WIP exceeded/);
  savePolicy(page);page.get('map-search').value='Story 1';page.get('map-search').listeners.get('input')();
  assert.match(page.get('map-stages').innerHTML,/WIP exceeded: 2 cached \/ 1/);
  assert.match(page.get('flow-board').innerHTML,/Entry:.*Story understood/);
  assert.equal(storage.size,1);
  const next=harness(storage);next.renderWorkMap(next.get('host'),policySnapshot());
  assert.match(next.get('map-stages').innerHTML,/WIP exceeded/);
  next.get('flow-policy-stage').value='ready';click(next,'flow-policy-reset');
  assert.equal(storage.size,0);assert.doesNotMatch(next.get('map-stages').innerHTML,/WIP exceeded/);
  assert.equal(page.requests.length,0);
});

test('policies are scoped by project and board and follow labels after board reorder',()=>{
  const storage=new Map(),first=harness(storage);
  const boards=[{id:1,lists:[{label:'Ready',position:0},{label:'Review',position:1}]}];
  first.renderWorkMap(first.get('host'),policySnapshot(boards));savePolicy(first,{stage:'list-0'});
  const other=harness(storage);other.renderWorkMap(other.get('host'),{...policySnapshot(boards),project:{webUrl:'https://gitlab.example.test/team/other'}});
  assert.doesNotMatch(other.get('map-stages').innerHTML,/WIP exceeded/);
  const board2=harness(storage);board2.renderWorkMap(board2.get('host'),policySnapshot([{...boards[0],id:2}]));
  assert.doesNotMatch(board2.get('map-stages').innerHTML,/WIP exceeded/);
  const reordered=harness(storage);reordered.renderWorkMap(reordered.get('host'),policySnapshot([{id:1,lists:[{label:'Ready',position:1},{label:'Review',position:0}]}]));
  assert.match(reordered.get('map-stages').innerHTML,/data-map-stage="list-1"[^]*?WIP exceeded/);
});

test('policy input rejects invalid limits and long text, escapes guidance, tolerates blocked storage',()=>{
  const page=harness(new Map(),true);page.renderWorkMap(page.get('host'),policySnapshot());
  for(const limit of ['0','-1','1.5','NaN','10001']) {savePolicy(page,{limit});assert.match(page.get('flow-policy-status').textContent,/whole-number/);}
  savePolicy(page,{entry:'x'.repeat(2001)});assert.match(page.get('flow-policy-status').textContent,/2000/);
  savePolicy(page,{entry:'<img src=x onerror=alert(1)>',exit:'</textarea><script>alert(1)</script>'});
  assert.match(page.get('flow-policy-status').textContent,/persistence unavailable/);
  assert.match(page.get('flow-board').innerHTML,/&lt;img/);
  assert.doesNotMatch(page.get('flow-board').innerHTML,/<img|<script/);
  savePolicy(page,{limit:''});assert.doesNotMatch(page.get('map-stages').innerHTML,/WIP exceeded/);
  assert.equal(page.validateStagePolicy({limit:1,entry:[],exit:''}),null);
});

test('invalid stored policies are ignored and projectless policies are never persisted',()=>{
  const storage=new Map(),page=harness(storage);page.renderWorkMap(page.get('host'),policySnapshot());savePolicy(page);
  storage.set([...storage.keys()][0],'{broken');const fresh=harness(storage);fresh.renderWorkMap(fresh.get('host'),policySnapshot());
  assert.doesNotMatch(fresh.get('map-stages').innerHTML,/WIP exceeded/);
  const empty=new Map(),projectless=harness(empty);projectless.renderWorkMap(projectless.get('host'),data([item(1,{labels:['Ready']})]));savePolicy(projectless);
  assert.equal(empty.size,0);assert.match(projectless.get('flow-policy-status').textContent,/persistence unavailable/);
});
