const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough.js'), 'utf8');
const ctx = { Math, Number, String, Object, Array, JSON, Boolean };
vm.createContext(ctx);
vm.runInContext(source, ctx);
const { linearizeScenario, walkthroughTotal, defaultBranchIndex, focusOfEntry } = ctx;

// Objects built inside the vm realm have that realm's prototypes, which deepStrictEqual rejects.
// Rebuilding them in the host realm keeps the assertions about values, not realms.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function step(id, from, to, edgeId) {
  const hop = { id: `${id}_hop`, from, to };
  if (edgeId) hop.edgeId = edgeId;
  return { id, kind: 'interaction', interactions: [hop] };
}

// One decision with a one-hop branch and a two-hop branch, followed by a trailing step.
function branchScenario() {
  return {
    stages: [
      {
        id: 'dec',
        kind: 'branch',
        condition: 'items intact?',
        branches: [
          { name: 'No', stages: [step('b0', 'a', 'b', 'e1')] },
          { name: 'Yes', stages: [step('b1', 'a', 'c', 'e2'), step('b2', 'c', 'd', 'e3')] },
        ],
      },
      step('after', 'd', 'e', 'e4'),
    ],
  };
}

const cases = [
  [
    'plain stages become numbered steps in order',
    () => {
      const entries = plain(linearizeScenario({ stages: [step('s1', 'a', 'b', 'e1'), step('s2', 'b', 'c', 'e2')] }, {}));
      assert.deepStrictEqual(entries.map((entry) => [entry.kind, entry.id, entry.number, entry.parallel]), [
        ['step', 's1', 1, false],
        ['step', 's2', 2, false],
      ]);
      assert.strictEqual(walkthroughTotal(entries), 2);
    },
  ],

  [
    'a parallel stage is one step carrying every hop, with numbered markers',
    () => {
      const scenario = {
        stages: [
          {
            id: 'par',
            kind: 'parallel',
            interactions: [
              { id: 'h1', from: 'a', to: 'b', edgeId: 'e1' },
              { id: 'h2', from: 'a', to: 'c' },
            ],
          },
        ],
      };
      const entries = plain(linearizeScenario(scenario, {}));
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].kind, 'step');
      assert.strictEqual(entries[0].parallel, true);
      assert.strictEqual(entries[0].interactions.length, 2);
      assert.strictEqual(walkthroughTotal(entries), 1);
      const focus = plain(focusOfEntry(entries, 0, []));
      assert.deepStrictEqual(focus.markers, [
        { edgeId: 'e1', from: 'a', to: 'b', n: 1 },
        { edgeId: null, from: 'a', to: 'c', n: 2 },
      ]);
    },
  ],

  [
    'a parallel stage without its own interactions collects them from nested stages',
    () => {
      const scenario = {
        stages: [
          {
            id: 'par',
            kind: 'parallel',
            stages: [
              step('c1', 'a', 'b', 'e1'),
              step('c2', 'b', 'c', 'e2'),
            ],
          },
        ],
      };
      const entries = plain(linearizeScenario(scenario, {}));
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].parallel, true);
      assert.deepStrictEqual(entries[0].interactions.map((hop) => hop.to), ['b', 'c']);
    },
  ],

  [
    'a branch takes the default branch when no choice is set',
    () => {
      const entries = plain(linearizeScenario(branchScenario(), {}));
      assert.deepStrictEqual(entries.map((entry) => entry.kind), ['decision', 'step', 'step']);
      assert.strictEqual(entries[0].id, 'dec');
      assert.strictEqual(entries[0].chosen, 0);
      assert.deepStrictEqual(entries[0].branches.map((branch) => branch.name), ['No', 'Yes']);
      assert.strictEqual(entries[1].id, 'b0');
      assert.strictEqual(entries[2].id, 'after');
      assert.deepStrictEqual(entries.filter((entry) => entry.kind === 'step').map((entry) => entry.number), [1, 2]);
      assert.strictEqual(walkthroughTotal(entries), 2);
    },
  ],

  [
    'an explicit choice selects another branch and renumbers the path',
    () => {
      const entries = plain(linearizeScenario(branchScenario(), { dec: 1 }));
      assert.deepStrictEqual(entries.map((entry) => entry.id), ['dec', 'b1', 'b2', 'after']);
      assert.strictEqual(entries[0].chosen, 1);
      assert.deepStrictEqual(entries.filter((entry) => entry.kind === 'step').map((entry) => entry.number), [1, 2, 3]);
      assert.strictEqual(walkthroughTotal(entries), 3);
    },
  ],

  [
    'a branch flagged default wins over the first branch',
    () => {
      const branch = {
        id: 'dec',
        kind: 'branch',
        branches: [
          { name: 'No', stages: [step('b0', 'a', 'b', 'e1')] },
          { name: 'Yes', default: true, stages: [step('b1', 'a', 'c', 'e2')] },
        ],
      };
      assert.strictEqual(defaultBranchIndex(branch), 1);
      const entries = plain(linearizeScenario({ stages: [branch] }, {}));
      assert.strictEqual(entries[0].chosen, 1);
      assert.strictEqual(entries[1].id, 'b1');
    },
  ],

  [
    'an out-of-range or malformed choice falls back to the default',
    () => {
      [{ dec: 9 }, { dec: -1 }, { dec: 'yes' }, { dec: 1.5 }, {}].forEach((choices) => {
        const entries = plain(linearizeScenario(branchScenario(), choices));
        assert.strictEqual(entries[0].chosen, 0, JSON.stringify(choices));
        assert.strictEqual(entries[1].id, 'b0');
      });
    },
  ],

  [
    'a chosen branch with no stages ends the path right after its decision',
    () => {
      const scenario = {
        stages: [
          {
            id: 'dec',
            kind: 'branch',
            branches: [
              { name: 'Dispatch Successful', stages: [] },
              { name: 'Recover', stages: [step('r1', 'a', 'b', 'e1')] },
            ],
          },
        ],
      };
      const entries = plain(linearizeScenario(scenario, {}));
      assert.deepStrictEqual(entries.map((entry) => entry.kind), ['decision', 'end']);
      assert.strictEqual(entries[1].id, 'end:dec');
      assert.strictEqual(entries[1].decisionId, 'dec');
      assert.strictEqual(entries[1].branch.name, 'Dispatch Successful');
      assert.strictEqual(walkthroughTotal(entries), 0);
    },
  ],

  [
    'a nested branch inside a chosen branch is linearized to the same rules',
    () => {
      const scenario = {
        stages: [
          {
            id: 'outer',
            kind: 'branch',
            branches: [
              {
                name: 'Go',
                stages: [
                  {
                    id: 'inner',
                    kind: 'branch',
                    branches: [
                      { name: 'X', stages: [step('x', 'a', 'b', 'e1')] },
                      { name: 'Y', stages: [step('y', 'a', 'c', 'e2')] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const explicit = plain(linearizeScenario(scenario, { outer: 0, inner: 1 }));
      assert.deepStrictEqual(explicit.map((entry) => entry.kind), ['decision', 'decision', 'step']);
      assert.strictEqual(explicit[1].id, 'inner');
      assert.strictEqual(explicit[1].chosen, 1);
      assert.strictEqual(explicit[2].id, 'y');
      assert.strictEqual(explicit[2].number, 1);

      const fallback = plain(linearizeScenario(scenario, {}));
      assert.strictEqual(fallback[1].chosen, 0);
      assert.strictEqual(fallback[2].id, 'x');
    },
  ],

  [
    'stages after a branch continue the chosen path',
    () => {
      const entries = plain(linearizeScenario(branchScenario(), { dec: 1 }));
      assert.strictEqual(entries[entries.length - 1].id, 'after');
      assert.strictEqual(entries[entries.length - 1].number, 3);
    },
  ],

  [
    'changing an upstream choice changes the path and the total',
    () => {
      const scenario = branchScenario();
      const first = linearizeScenario(scenario, { dec: 0 });
      const second = linearizeScenario(scenario, { dec: 1 });
      assert.notDeepStrictEqual(plain(first).map((entry) => entry.id), plain(second).map((entry) => entry.id));
      assert.strictEqual(walkthroughTotal(first), 2);
      assert.strictEqual(walkthroughTotal(second), 3);
    },
  ],

  [
    'a hop without an edge becomes a ghost, and edges resolve by endpoints',
    () => {
      const scenario = { stages: [step('s1', 'a', 'b'), step('s2', 'b', 'c', 'e2')] };
      const edges = [{ id: 'e9', source: 'a', target: 'b' }];
      const entries = linearizeScenario(scenario, {});

      const withoutEdges = plain(focusOfEntry(entries, 0, []));
      assert.deepStrictEqual(withoutEdges.primaryNodes, ['a', 'b']);
      assert.deepStrictEqual(withoutEdges.primaryEdges, []);
      assert.deepStrictEqual(withoutEdges.ghosts, [{ from: 'a', to: 'b' }]);
      assert.deepStrictEqual(withoutEdges.markers, []);

      const withEdges = plain(focusOfEntry(entries, 0, edges));
      assert.deepStrictEqual(withEdges.primaryEdges, ['e9']);
      assert.deepStrictEqual(withEdges.ghosts, []);

      const named = plain(focusOfEntry(entries, 1, edges));
      assert.deepStrictEqual(named.primaryEdges, ['e2']);
    },
  ],

  [
    'decision focus comes from decidedBy, or from where the path arrived',
    () => {
      const decidedBy = {
        stages: [
          step('s1', 'a', 'b', 'e1'),
          { id: 'dec', kind: 'branch', decidedBy: 'nodeQ', branches: [{ name: 'ok', stages: [step('b0', 'b', 'c', 'e2')] }] },
        ],
      };
      const decidedEntries = linearizeScenario(decidedBy, {});
      const decidedFocus = plain(focusOfEntry(decidedEntries, 1, []));
      assert.deepStrictEqual(decidedFocus.primaryNodes, ['nodeQ']);
      assert.deepStrictEqual(decidedFocus.primaryEdges, []);
      assert.deepStrictEqual(decidedFocus.ghosts, []);

      const arrived = { stages: [step('s1', 'a', 'b', 'e1'), { id: 'dec', kind: 'branch', branches: [{ name: 'ok', stages: [step('b0', 'b', 'c', 'e2')] }] }] };
      const arrivedEntries = linearizeScenario(arrived, {});
      assert.deepStrictEqual(plain(focusOfEntry(arrivedEntries, 1, [])).primaryNodes, ['b']);

      const empty = { stages: [{ id: 'dec', kind: 'branch', branches: [{ name: 'empty', stages: [] }] }] };
      const emptyEntries = linearizeScenario(empty, {});
      assert.deepStrictEqual(plain(focusOfEntry(emptyEntries, 1, [])).primaryNodes, []);
    },
  ],

  [
    'an end entry focuses wherever its decision does',
    () => {
      const scenario = {
        stages: [
          step('s1', 'a', 'b', 'e1'),
          { id: 'dec', kind: 'branch', branches: [{ name: 'stop', stages: [] }] },
        ],
      };
      const entries = linearizeScenario(scenario, {});
      assert.strictEqual(entries[2].kind, 'end');
      assert.deepStrictEqual(plain(focusOfEntry(entries, 2, [])).primaryNodes, ['b']);
    },
  ],

  [
    'empty and malformed scenarios never throw',
    () => {
      assert.deepStrictEqual(plain(linearizeScenario()), []);
      assert.deepStrictEqual(plain(linearizeScenario({})), []);
      assert.deepStrictEqual(plain(linearizeScenario({ stages: null }, {})), []);
      assert.deepStrictEqual(plain(linearizeScenario({ stages: [null, { kind: 'branch' }] }, {})).map((entry) => entry.kind), ['decision', 'end']);
      assert.strictEqual(walkthroughTotal(null), 0);
      const emptyFocus = plain(focusOfEntry([], 0, []));
      assert.deepStrictEqual(emptyFocus.primaryNodes, []);
    },
  ],

  [
    'the real example walks to a successful end by default and to DLQ recovery on demand',
    () => {
      const { compileArchitecture } = require('../src/engine/compiler.js');
      const specPath = path.join(__dirname, '../examples/3-async-event-driven-workflow/architecture.json');
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const { html } = compileArchitecture(spec);
      const match = html.match(/const ARCH_SPEC = (\{[\s\S]*?\});\n/);
      assert.ok(match, 'the compiled page embeds ARCH_SPEC');
      const archSpec = JSON.parse(match[1]);
      const scenario = archSpec.scenarios[0];

      const defaultEntries = linearizeScenario(scenario, {});
      const defaultEnd = defaultEntries[defaultEntries.length - 1];
      assert.strictEqual(defaultEnd.kind, 'end');
      assert.strictEqual(defaultEnd.decisionId, 'stage_warehouse_outcome_branch');
      assert.strictEqual(defaultEnd.branch.name, 'Dispatch Successful');
      const defaultTotal = walkthroughTotal(defaultEntries);

      const recoveryEntries = linearizeScenario(scenario, { stage_warehouse_outcome_branch: 1 });
      const recoverySteps = recoveryEntries.filter((entry) => entry.kind === 'step').map((entry) => entry.id);
      assert.ok(recoverySteps.includes('stage_route_dlq'));
      assert.ok(recoverySteps.includes('stage_compensation_release_inventory'));
      assert.ok(walkthroughTotal(recoveryEntries) > defaultTotal, `${walkthroughTotal(recoveryEntries)} > ${defaultTotal}`);
      assert.strictEqual(recoveryEntries.some((entry) => entry.kind === 'end'), false);
    },
  ],
];

cases.push(['synthetic ends cannot shadow authored stages on any outcome', () => {
  const scenario = { stages: [{ id: 'dec', kind: 'branch', branches: [{ stages: [] }] }, step('end:dec', 'a', 'b'), step('end:end:dec', 'b', 'c')] };
  const entries = plain(linearizeScenario(scenario, {}));
  assert.strictEqual(new Set(entries.map(entry => entry.id)).size, entries.length);
  assert.strictEqual(entries[1].id, 'end:end:end:dec');
  assert.strictEqual(entries.find(entry => entry.id === 'end:dec').kind, 'step');
  const consecutive = plain(linearizeScenario({ stages: ['dec', 'end:dec'].map(id => ({ id, kind: 'branch', branches: [{ stages: [] }] })) }, {}));
  assert.strictEqual(new Set(consecutive.map(entry => entry.id)).size, consecutive.length);
}]);

cases.push(['scenario paths enumerate nested and later decision combinations', () => {
  const decision = (id, stages) => ({ id, kind: 'branch', branches: stages.map(stages => ({ stages })) });
  const scenario = { stages: [decision('first', [[decision('nested', [[step('n0', 'a', 'b')], [step('n1', 'a', 'c')]])], []]), decision('later', [[step('l0', 'b', 'd')], [step('l1', 'c', 'd')]])] };
  const paths = plain(ctx.walkScenarioPaths(scenario));
  assert.strictEqual(paths.length, 6);
  assert.ok(paths.some(path => path.choices.nested === 1 && path.choices.later === 1 && path.entries.some(entry => entry.id === 'n1') && path.entries.some(entry => entry.id === 'l1')));
}]);

cases.push(['walkthrough autoplay uses positive stage or interaction durations', () => {
  const ui = vm.createContext({ Number, Math });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough-ui.js'), 'utf8'), ui);
  assert.strictEqual(ui.walkStartDelay({ stage: {}, interactions: [{ durationMs: 640 }] }), 640);
  assert.strictEqual(ui.walkStartDelay({ stage: { durationMs: 900 }, interactions: [{ durationMs: 640 }] }), 900);
  assert.strictEqual(ui.walkStartDelay({ stage: { durationMs: 0 }, interactions: [{ durationMs: -2 }] }), 2600);
}]);

cases.push(['sequence playback defaults nonpositive and nonfinite durations', () => {
  let delay;
  const sequence = vm.createContext({ Number, state: { sequenceIndex: 0 }, setTimeout: (fn, ms) => { delay = ms; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/sequence.js'), 'utf8'), sequence);
  [0, -1, NaN, Infinity, undefined, 720].forEach(durationMs => {
    sequence.sequenceSteps = () => [{ durationMs }];
    sequence.scheduleNextStep();
    assert.strictEqual(delay, durationMs === 720 ? 720 : 1800);
  });
}]);

cases.push(['idle walkthrough total includes shared steps after empty and nonempty outcomes', () => {
  const ui = vm.createContext({ Number, Math });
  vm.runInContext(source, ui);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough-ui.js'), 'utf8'), ui);
  const scenario = branchScenario();
  assert.strictEqual(ui.walkAllStepsTotal(scenario), 4);
  scenario.stages[0].branches.forEach(branch => { branch.stages = []; });
  assert.strictEqual(ui.walkAllStepsTotal(scenario), 1);
}]);

cases.push(['parallel markers replace prior focus and clear on empty focus', () => {
  const groups = [];
  const ui = vm.createContext({
    ghostLayer: { querySelectorAll: () => groups.slice(), appendChild: group => groups.push(group) },
    el: () => ({ appendChild() {}, remove() { groups.splice(groups.indexOf(this), 1); } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough-ui.js'), 'utf8'), ui);
  ui.walkMarkerPoint = () => ({ x: 0, y: 0 });
  ui.drawWalkMarkers([{ n: 1 }]);
  ui.drawWalkMarkers([{ n: 2 }]);
  assert.strictEqual(groups.length, 1);
  ui.drawWalkMarkers([]);
  assert.strictEqual(groups.length, 0);
}]);

cases.push(['packet recovery status is evaluated for each interaction', () => {
  const packets = [];
  const layer = { replaceChildren: () => { packets.length = 0; }, appendChild: group => packets.push(group) };
  const edge = { id: 'e', source: 'a', target: 'b' };
  const ui = vm.createContext({
    state: { prefersReducedMotion: false }, LAYOUT_DATA: { edges: [edge] }, edgeById: new Map([['e', edge]]),
    document: { getElementById: id => id === 'walk-packets' ? layer : { getTotalLength: () => 100 } },
    window: { clearTimeout() {}, setTimeout() {}, requestAnimationFrame() {} }, performance: { now: () => 0 },
    el: (tag, attrs) => ({ attrs, appendChild() {} }),
  });
  vm.runInContext(source, ui);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough-ui.js'), 'utf8'), ui);
  ui.playWalkPackets([{ kind: 'step', interactions: [{ from: 'a', to: 'b', status: 'recovery' }, { from: 'a', to: 'b' }] }], 0);
  assert.deepStrictEqual(packets.map(packet => packet.attrs.class), ['walk-packet recovery', 'walk-packet']);
}]);

cases.push(['review r2: playback advances from the current walkthrough cursor', () => {
  const entries = [0, 1, 2, 3].map(n => ({ id: String(n), kind: 'step', interactions: [] }));
  let index = 0, callback;
  const ui = { window: { setTimeout: fn => { callback = fn; return 1; } },
    walkCurrent: () => ({ entries, index, entry: entries[index] }),
    walkTo: id => { index = Number(id); }, walkStartDelay: () => 1 };
  vm.createContext(ui);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/walkthrough-ui.js'), 'utf8'), ui);
  ui.walkCurrent = () => ({ entries, index, entry: entries[index] });
  ui.walkTo = id => { index = Number(id); };
  vm.runInContext('walkPlaying = true; scheduleWalkStep()', ui);
  index = 2;
  callback();
  assert.strictEqual(index, 3);
}]);
cases.push(['review r2: an empty sequence stops without scheduling a timer', () => {
  let scheduled = 0;
  const ui = { ARCH_SPEC: { views: { sequence: { steps: [] } } }, state: { sequencePlaying: true },
    setTimeout: () => { scheduled++; }, document: { getElementById: () => null } };
  vm.createContext(ui);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/sequence.js'), 'utf8'), ui);
  ui.scheduleNextStep();
  assert.strictEqual(scheduled, 0);
  assert.strictEqual(ui.state.sequencePlaying, false);
}]);
cases.push(['review r2: reverse sequence hops use oriented ghosts', () => {
  const edge = { id: 'edge', source: 'a', target: 'b' };
  const ui = { LAYOUT_DATA: { edges: [edge] }, edgeById: new Map([[edge.id, edge]]) };
  vm.createContext(ui);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/sequence.js'), 'utf8'), ui);
  assert.strictEqual(ui.interactionEdge({ from: 'a', to: 'b' }), edge);
  assert.strictEqual(ui.interactionEdge({ from: 'b', to: 'a' }), null);
  assert.strictEqual(ui.interactionEdge({ from: 'b', to: 'a', edgeId: 'edge' }), null);
}]);

module.exports = { name: 'Walkthrough engine', cases };
