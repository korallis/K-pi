#!/usr/bin/env node
// Synthetic PR API boundary only. Git push and remote verification remain real.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const root = process.env.METRIC_DELIVERY_ROOT;
function deny(reason) { fs.appendFileSync(`${root}/gh.jsonl`, JSON.stringify({ args, denied: reason }) + '\n'); console.error(reason); process.exit(1); }
if (!root) process.exit(1);
const view = args.length === 5 && args[0] === 'pr' && args[1] === 'view' && args[3] === '--json' && args[4] === 'url,state';
const create = args.length === 5 && args[0] === 'pr' && args[1] === 'create' && args[2] === '--head' && args[4] === '--fill';
const branch = view ? args[2] : create ? args[3] : '';
if (!/^kpi\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) deny('unsupported fixture gh command');
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const remote = git('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
if (git('remote', 'get-url', 'origin') !== `${root}/origin.git` || head !== remote) deny('PR boundary requires the actual local origin candidate');
const path = `${root}/pr.json`;
fs.appendFileSync(`${root}/gh.jsonl`, JSON.stringify({ args, head, remote, synthetic: true }) + '\n');
if (create) {
  if (fs.existsSync(path)) deny('duplicate PR creation');
  fs.writeFileSync(path, JSON.stringify({ url: 'https://fixture.invalid/pull/1', state: 'OPEN', branch, head, synthetic: true }));
}
if (!fs.existsSync(path)) { console.error('no pull requests found'); process.exit(1); }
const record = JSON.parse(fs.readFileSync(path, 'utf8'));
if (record.branch !== branch || record.head !== head) deny('stale synthetic PR');
console.log(view ? JSON.stringify({ url: record.url, state: record.state }) : record.url);
