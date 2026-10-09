const assert = require('node:assert');
const { narrateInteraction, narrateStage, narrateScenario } = require('../src/engine/narrative.js');

const labels = (id) => ({ api: 'API Service', db: 'Orders DB' }[id] || id);

const cases = [
  [
    'narrates an interaction with labels resolved through nodeLabel',
    () => {
      const sentence = narrateInteraction({ from: 'api', to: 'db', label: 'Insert order' }, labels);
      assert.strictEqual(sentence, 'API Service sends Insert order to Orders DB.');
    },
  ],

  [
    'falls back to the node id when nodeLabel has no label',
    () => {
      const sentence = narrateInteraction({ from: 'api', to: 'db', label: 'Insert order' }, () => undefined);
      assert.strictEqual(sentence, 'api sends Insert order to db.');
    },
  ],

  [
    'says "calls" when the interaction has no label',
    () => {
      const sentence = narrateInteraction({ from: 'api', to: 'db' }, labels);
      assert.strictEqual(sentence, 'API Service calls Orders DB.');
    },
  ],

  [
    'appends the payload, stringifying scalars and shaping objects',
    () => {
      const sentence = narrateInteraction(
        { from: 'api', to: 'db', label: 'Insert order', payload: { id: 1, active: true, nested: { a: 1 }, name: 'Bob' } },
        labels
      );
      assert.strictEqual(sentence, 'API Service sends Insert order to Orders DB. Payload: id=1, active=true, nested={…}, name=Bob.');
    },
  ],

  [
    'truncates the payload to its first four keys',
    () => {
      const sentence = narrateInteraction(
        { from: 'api', to: 'db', label: 'Insert order', payload: { a: 1, b: 2, c: 3, d: 4, e: 5 } },
        labels
      );
      assert.strictEqual(sentence, 'API Service sends Insert order to Orders DB. Payload: a=1, b=2, c=3, d=4.');
      assert.ok(!sentence.includes('e=5'));
    },
  ],

  [
    'narrates a parallel stage as a semicolon-joined run of hops',
    () => {
      const stage = {
        kind: 'parallel',
        interactions: [
          { from: 'api', to: 'db', label: 'A' },
          { from: 'db', to: 'api', label: 'B' },
        ],
      };
      assert.strictEqual(
        narrateStage(stage, labels),
        'In parallel: API Service sends A to Orders DB; Orders DB sends B to API Service.'
      );
    },
  ],

  [
    'drops only the final period of each parallel hop',
    () => {
      const stage = { kind: 'parallel', interactions: [{ from: 'api', to: 'db', label: 'A', payload: { x: 1 } }] };
      assert.strictEqual(narrateStage(stage, labels), 'In parallel: API Service sends A to Orders DB. Payload: x=1.');
    },
  ],

  [
    'narrates a branch stage with its outcomes',
    () => {
      const stage = {
        kind: 'branch',
        condition: 'write succeeded',
        branches: [
          { name: 'Success', condition: 'row committed' },
          { name: 'Failure', condition: 'write failed' },
        ],
      };
      assert.strictEqual(
        narrateStage(stage, labels),
        'Decision: write succeeded. Outcomes: Success (row committed), Failure (write failed).'
      );
    },
  ],

  [
    'narrates an interaction stage through its single interaction',
    () => {
      const stage = {
        kind: 'interaction',
        interactions: [{ from: 'api', to: 'db', label: 'Insert order' }],
      };
      assert.strictEqual(narrateStage(stage, labels), narrateInteraction(stage.interactions[0], labels));
      assert.strictEqual(narrateStage(stage, labels), 'API Service sends Insert order to Orders DB.');
    },
  ],

  [
    'keeps an authored stage or interaction narrative instead of generating one',
    () => {
      const stage = { kind: 'interaction', narrative: 'A hand-written stage.', interactions: [{ from: 'api', to: 'db', label: 'X' }] };
      assert.strictEqual(narrateStage(stage, labels), 'A hand-written stage.');
      const interaction = { from: 'api', to: 'db', label: 'X', narrative: 'A hand-written hop.' };
      assert.strictEqual(narrateInteraction(interaction, labels), 'A hand-written hop.');
    },
  ],

  [
    'narrates nested branches recursively through narrateScenario',
    () => {
      const scenario = {
        stages: [
          {
            id: 'outer',
            name: 'Outer',
            kind: 'branch',
            condition: 'outer?',
            branches: [
              {
                name: 'B1',
                condition: 'c1',
                stages: [
                  {
                    id: 'inner',
                    name: 'Inner',
                    kind: 'branch',
                    condition: 'inner?',
                    branches: [
                      {
                        name: 'B2',
                        condition: 'c2',
                        stages: [
                          { id: 'leaf', name: 'Leaf', kind: 'interaction', interactions: [{ from: 'api', to: 'db', label: 'Do' }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const steps = narrateScenario(scenario, labels);
      assert.strictEqual(steps[0].narrative, 'Decision: outer?. Outcomes: B1 (c1).');
      assert.strictEqual(steps[0].outcomes[0].name, 'B1');
      assert.strictEqual(steps[0].outcomes[0].stages[0].narrative, 'Decision: inner?. Outcomes: B2 (c2).');
      assert.strictEqual(
        steps[0].outcomes[0].stages[0].outcomes[0].stages[0].narrative,
        'API Service sends Do to Orders DB.'
      );
    },
  ],

  [
    'returns an empty list for a malformed scenario',
    () => {
      assert.deepStrictEqual(narrateScenario(null, labels), []);
      assert.deepStrictEqual(narrateScenario({}, labels), []);
    },
  ],
];

module.exports = { name: 'Narrative', cases };
