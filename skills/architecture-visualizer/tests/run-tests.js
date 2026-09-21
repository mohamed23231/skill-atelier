#!/usr/bin/env node

const suites = [
  require('./validator.test.js'),
  require('./layout.test.js'),
  require('./compiler.test.js'),
  require('./cli.test.js'),
  require('./scaffold.test.js'),
  require('./rendered.test.js')
];

console.log('====================================================');
console.log('  Running Architecture Visualizer Test Suite        ');
console.log('====================================================\n');

let passed = 0;
const failures = [];

suites.forEach(suite => {
  console.log(`${suite.name}`);
  suite.cases.forEach(([name, fn]) => {
    try {
      fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failures.push({ suite: suite.name, name, err });
      console.log(`  ❌ ${name}`);
    }
  });
  console.log('');
});

if (failures.length > 0) {
  console.log('Failures:');
  failures.forEach(f => {
    console.log(`\n❌ ${f.suite} › ${f.name}`);
    console.log(String(f.err && f.err.stack ? f.err.stack : f.err).split('\n').slice(0, 6).join('\n'));
  });
  console.log('');
}

console.log('----------------------------------------------------');
console.log(`Results: ${passed} passed, ${failures.length} failed (${passed + failures.length} tests).`);
console.log('----------------------------------------------------');
process.exit(failures.length > 0 ? 1 : 0);
