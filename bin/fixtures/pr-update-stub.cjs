#!/usr/bin/env node
'use strict';

/**
 * bin/fixtures/pr-update-stub.cjs - the stub `gh` and `git` the pr-update tests copy onto PATH.
 *
 * It answers only the READ verbs bin/pr-update.cjs runs, from the JSON state file $PR_UPDATE_STUB_STATE (the test
 * edits that file between invocations to play the caller who ran an emitted write). Every call appends its argv as
 * one JSON line to $PR_UPDATE_STUB_LOG. Any write verb (pr edit/comment, api -X/--method/-f/-F/--input, git push)
 * appends a REFUSED line and exits 99, so a test can prove pr-update never spawns a write.
 *
 * State keys: pr {headRefOid, headRefName, isCrossRepository, headRepositoryOwner, body, title},
 *   remoteHeads {"<remote> <branch>": sha}, selftest {ymlSha, blobSha, branchHead, runs[], artifactDir},
 *   comments [{body}].
 */

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const argv = process.argv.slice(2);
  const tool = path.basename(process.argv[1]) === 'git' ? 'git' : 'gh';
  const state = JSON.parse(fs.readFileSync(process.env.PR_UPDATE_STUB_STATE, 'utf8'));
  const log = (extra) => fs.appendFileSync(process.env.PR_UPDATE_STUB_LOG, JSON.stringify({ tool, argv, ...extra }) + '\n');
  const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
  const fail = (msg, code = 1) => {
    process.stderr.write(msg + '\n');
    process.exitCode = code;
  };
  const refuse = () => {
    log({ REFUSED: true });
    fail('stub: write refused', 99);
  };
  const st = state.selftest || {};

  if (tool === 'git') {
    const i = argv.indexOf('ls-remote');
    if (argv.includes('push') || i < 0) return refuse();
    log({});
    const remote = argv[i + 1];
    const branch = String(argv[i + 2] || '').replace('refs/heads/', '');
    const sha = (state.remoteHeads || {})[`${remote} ${branch}`];
    if (sha) out(`${sha}\trefs/heads/${branch}\n`);
    return;
  }
  const writeFlag = argv.some((a) => ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(a));
  if (writeFlag || (argv[0] === 'pr' && ['edit', 'comment', 'create', 'merge', 'close', 'ready'].includes(argv[1]))) return refuse();
  log({});
  if (argv[0] === 'pr' && argv[1] === 'view') return out(state.pr);
  if (argv[0] === 'run' && argv[1] === 'download') {
    const d = argv[argv.indexOf('-D') + 1];
    fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(st.artifactDir)) {
      if (fs.existsSync(path.join(d, f))) return fail(`error downloading selftest: file exists: ${f}`);
      fs.copyFileSync(path.join(st.artifactDir, f), path.join(d, f));
    }
    return;
  }
  if (argv[0] !== 'api') return fail(`stub: unexpected verb ${argv.join(' ')}`, 99);
  const p = argv.find((a) => /^repos\//.test(a)) || '';
  if (/\/contents\/\.github\/workflows\/selftest\.yml/.test(p)) {
    const yml = `name: selftest\non: push\nenv:\n  SELFTEST_REPO: davesienkowski/gsd-core\n  SELFTEST_SHA: ${st.ymlSha}\n`;
    return out({ sha: st.blobSha, encoding: 'base64', content: Buffer.from(yml).toString('base64') });
  }
  if (/\/branches\/selftest\/run/.test(p)) return out({ commit: { sha: st.branchHead } });
  if (/\/actions\/runs\/\d+$/.test(p)) {
    const r = (st.runs || []).find((x) => x.id === Number(p.split('/').pop()));
    return r ? out(r) : fail('gh: Not Found (HTTP 404)');
  }
  if (/\/actions\/runs\?/.test(p)) return out({ workflow_runs: st.runs || [] });
  if (/\/issues\/\d+\/comments/.test(p)) return out(state.commentsPages || state.comments || []);
  return fail(`stub: unexpected api read ${p}`);
}

main();
