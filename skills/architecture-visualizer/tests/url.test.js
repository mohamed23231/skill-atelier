const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/url.js'), 'utf8');
const ctx = { URLSearchParams, Math, Number, String, Object, JSON };
vm.createContext(ctx);
vm.runInContext(source, ctx);
const { encodeViewHash, parseViewHash, cameraToWorld, worldToCamera } = ctx;

// Objects built inside the vm realm have that realm's prototypes, which deepStrictEqual rejects.
// Rebuilding them in the host realm keeps the assertions about values, not realms.
function camp(hash) {
  return JSON.parse(JSON.stringify(parseViewHash(hash)));
}

// Everything a version 2 snapshot can carry, in one object.
function fullSnapshot() {
  return {
    chapter: 'review',
    lens: 'risk',
    view: 'sequence',
    node: 'api',
    edge: 'e1',
    scenario: 's1',
    stage: 'stage-one',
    step: 3,
    filter: 'async',
    focus: 'neighbors',
    present: true,
    camera: { x: 10.04, y: -20.06, w: 0.96 },
  };
}

const V1_HASH = '#view=sequence&node=api&edge=e1&filter=async&step=2&scenario=s1&stage=3&focus=neighbors&present=1&z=0.9&x=10&y=20';

const cases = [
  [
    'lens defaults to structure and is omitted',
    () => {
      assert.strictEqual(encodeViewHash({ lens: 'structure' }), 'v=2');
      assert.deepStrictEqual(camp('v=2'), { version: 2 });
    },
  ],
  [
    'lens is parsed only in version 2 and all nondefault lenses round trip',
    () => {
      ['evidence', 'change', 'risk'].forEach(lens => {
        assert.deepStrictEqual(camp(encodeViewHash({ lens })), { version: 2, lens });
      });
      assert.deepStrictEqual(camp('l=risk&view=before_after'), { version: 1, view: 'before_after' });
      assert.deepStrictEqual(camp('v=2&l=structure'), { version: 2, lens: 'structure' });
    },
  ],
  [
    'a full version 2 snapshot round trips through encode and parse',
    () => {
      const snapshot = fullSnapshot();
      const hash = encodeViewHash(snapshot);
      assert.strictEqual(camp(hash).version, 2);
      assert.deepStrictEqual(camp(hash), {
        version: 2,
        chapter: 'review',
        lens: 'risk',
        view: 'sequence',
        node: 'api',
        edge: 'e1',
        scenario: 's1',
        stage: 'stage-one',
        step: 3,
        filter: 'async',
        focus: 'neighbors',
        present: true,
        camera: { x: 10, y: -20.1, w: 1 },
      });
    },
  ],

  [
    'each version 2 field survives on its own',
    () => {
      const expected = {
        chapter: 'review',
        lens: 'risk',
        view: 'sequence',
        node: 'api',
        edge: 'e1',
        scenario: 's1',
        stage: 'stage-one',
        step: 3,
        filter: 'async',
        focus: 'neighbors',
        present: true,
        camera: { x: 10, y: -20.1, w: 1 },
      };
      Object.keys(expected).forEach((field) => {
        const parsed = camp(encodeViewHash({ [field]: fullSnapshot()[field] }));
        assert.strictEqual(parsed.version, 2, `${field}: version`);
        assert.deepStrictEqual(parsed[field], expected[field], `${field}: value`);
      });
    },
  ],

  [
    'encode is stable when fed back through parse',
    () => {
      const snapshot = fullSnapshot();
      assert.strictEqual(encodeViewHash(parseViewHash(encodeViewHash(snapshot))), encodeViewHash(snapshot));
    },
  ],

  [
    'keys are emitted in the fixed order, and only when set',
    () => {
      const hash = encodeViewHash(fullSnapshot());
      assert.strictEqual(hash, 'v=2&c=review&l=risk&view=sequence&n=api&e=e1&s=s1&at=stage-one&step=3&filter=async&focus=neighbors&present=1&cam=10,-20.1,1');
    },
  ],

  [
    'view defaults to architecture and is omitted',
    () => {
      assert.strictEqual(encodeViewHash({ view: 'architecture', node: 'api' }), 'v=2&n=api');
      assert.deepStrictEqual(camp('v=2&n=api'), { version: 2, node: 'api' });
    },
  ],

  [
    'walkthrough outcomes encode after at as decision:index pairs',
    () => {
      assert.strictEqual(
        encodeViewHash({ scenario: 's1', stage: 'stage-two', outcomes: { dec: 1, other: 0 } }),
        'v=2&s=s1&at=stage-two&o=dec:1,other:0'
      );
      assert.deepStrictEqual(camp('v=2&s=s1&at=stage-two&o=dec:1,other:0'), {
        version: 2,
        scenario: 's1',
        stage: 'stage-two',
        outcomes: { dec: 1, other: 0 },
      });
    },
  ],

  [
    'outcomes keep a stable key order and stay behind at but before step',
    () => {
      assert.strictEqual(encodeViewHash({ outcomes: { z: 1, a: 0 } }), 'v=2&o=a:0,z:1');
      assert.strictEqual(
        encodeViewHash({ scenario: 's1', stage: 'e1', outcomes: { dec: 1 }, step: 3 }),
        'v=2&s=s1&at=e1&o=dec:1&step=3'
      );
    },
  ],

  [
    'malformed outcome pairs are dropped rather than guessed',
    () => {
      assert.strictEqual('outcomes' in camp('v=2'), false);
      assert.deepStrictEqual(camp('v=2&o=dec:1,neg:-1,bad,frac:1.5').outcomes, { dec: 1 });
      assert.strictEqual(camp('v=2&o=bad').outcomes, undefined);
      assert.strictEqual(encodeViewHash({ outcomes: { dec: -1, none: 'x' } }), 'v=2');
    },
  ],

  [
    'chapter defaults to overview and is omitted',
    () => {
      assert.strictEqual(encodeViewHash({ chapter: 'overview', node: 'api' }), 'v=2&n=api');
      assert.deepStrictEqual(camp('v=2&n=api'), { version: 2, node: 'api' });
    },
  ],

  [
    'ids with ampersands, equals, spaces and unicode round trip',
    () => {
      ['a&b', 'a=b', 'two words', 'café', '日本語', 'a&b=c d日本語'].forEach((node) => {
        const hash = encodeViewHash({ node });
        assert.deepStrictEqual(camp(hash), { version: 2, node });
      });
    },
  ],

  [
    'version 1 parses every field, including the zero indices',
    () => {
      const parsed = camp(V1_HASH);
      assert.deepStrictEqual(parsed, {
        version: 1,
        view: 'sequence',
        node: 'api',
        edge: 'e1',
        filter: 'async',
        scenario: 's1',
        focus: 'neighbors',
        present: true,
        stepIndex: 2,
        stageIndex: 3,
        screenCamera: { zoom: 0.9, panX: 10, panY: 20 },
      });
    },
  ],

  [
    'version 1 keeps zero step, zero stage and the zero-based index names',
    () => {
      const parsed = camp('#step=0&stage=0');
      assert.strictEqual(parsed.stepIndex, 0);
      assert.strictEqual(parsed.stageIndex, 0);
      assert.strictEqual(parsed.step, undefined);
      assert.strictEqual(parsed.stage, undefined);
    },
  ],

  [
    'version 1 with only x keeps just that pan value',
    () => {
      const parsed = camp('#x=5');
      assert.deepStrictEqual(parsed, { version: 1, screenCamera: { panX: 5 } });
    },
  ],

  [
    'version 1 leaves absent parameters absent rather than reading them as zero',
    () => {
      const parsed = camp('');
      assert.deepStrictEqual(parsed, { version: 1 });
      assert.strictEqual('node' in parsed, false);
      assert.strictEqual('screenCamera' in parsed, false);
    },
  ],

  [
    'a malformed version 2 camera is dropped, not guessed',
    () => {
      assert.strictEqual(camp('v=2&cam=1,2').camera, undefined);
      assert.strictEqual(camp('v=2&cam=1,NaN,3').camera, undefined);
      assert.strictEqual(camp('v=2&cam=1,2,0').camera, undefined);
      assert.strictEqual(camp('v=2&cam=1,2,-3').camera, undefined);
      assert.strictEqual(camp('v=2&cam=1,2').version, 2);
      assert.deepStrictEqual(camp('v=2&cam=1,2,3').camera, { x: 1, y: 2, w: 3 });
    },
  ],

  [
    'an unsupported version is reported without other fields',
    () => {
      assert.deepStrictEqual(camp('v=3&node=api'), { version: 3, unsupported: true });
      assert.deepStrictEqual(camp('v=abc&node=api'), { version: 'abc', unsupported: true });
    },
  ],

  [
    'empty, bare hash and garbage input never throw',
    () => {
      assert.deepStrictEqual(camp(''), { version: 1 });
      assert.deepStrictEqual(camp('#'), { version: 1 });
      assert.deepStrictEqual(camp('#&&&nope=1&node='), { version: 1 });
      assert.deepStrictEqual(camp('not a hash'), { version: 1 });
    },
  ],

  [
    'camera conversion agrees both ways at desktop and phone sizes',
    () => {
      [[1440, 900], [390, 844]].forEach(([width, height]) => {
        const size = { width, height };
        const camera = { zoom: 0.9, panX: 10, panY: -20 };
        const world = cameraToWorld(camera, size);
        const back = worldToCamera(world, size);
        assert.ok(Math.abs(back.zoom - camera.zoom) < 1e-9, `${width}: zoom`);
        assert.ok(Math.abs(back.panX - camera.panX) < 1e-9, `${width}: panX`);
        assert.ok(Math.abs(back.panY - camera.panY) < 1e-9, `${width}: panY`);
        assert.ok(Math.abs(world.w - width / camera.zoom) < 1e-9, `${width}: w`);
      });
    },
  ],
];

cases.push(['the Change lens mode round trips and Diff, the default, is omitted', () => {
  ['current', 'proposed'].forEach(delta => {
    assert.deepStrictEqual(camp(encodeViewHash({ lens: 'change', delta })), { version: 2, lens: 'change', delta });
  });
  assert.strictEqual(encodeViewHash({ lens: 'change', delta: 'diff' }), 'v=2&l=change');
}]);

module.exports = { name: 'URL codec', cases };
