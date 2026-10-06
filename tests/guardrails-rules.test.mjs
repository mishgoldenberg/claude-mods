// Unit tests for the guardrails rule patterns: run with `npm test`.
import ts from 'typescript'
import fs from 'fs'
const src = fs.readFileSync('plugins/guardrails/hooks/register.tsx', 'utf8').replace(/^import .*$/gm, '')
const js = ts.transpileModule(src, { compilerOptions: { module: 99, target: 99, jsx: 2, jsxFactory: 'h' } }).outputText
const mod = await import('data:text/javascript,' + encodeURIComponent('const atom=()=>({});' + js))
const R = Object.fromEntries(mod.RULES.map(r => [r.id, r]))
const root = 'C:/Users/me/proj'
const bash = command => ({ tool: 'Bash', input: { command }, root, cwd: root })
const file = (tool, file_path) => ({ tool, input: { file_path }, root, cwd: root })
const cases = [
  ['no-rm-rf', bash('rm -rf node_modules'), true], ['no-rm-rf', bash('rm -fr /'), true], ['no-rm-rf', bash('rm -r -f x'), true],
  ['no-rm-rf', bash('Remove-Item -Recurse -Force .\\dist'), true], ['no-rm-rf', bash('rm file.txt'), false], ['no-rm-rf', bash('rm -r dir'), false],
  ['no-force-push', bash('git push --force origin main'), true], ['no-force-push', bash('git push -f'), true],
  ['no-force-push', bash('git push --force-with-lease'), false], ['no-force-push', bash('git push origin main'), false],
  ['no-history-rewrite', bash('git reset --hard HEAD~1'), true], ['no-history-rewrite', bash('git clean -fd'), true], ['no-history-rewrite', bash('git reset HEAD file'), false],
  ['no-history-rewrite', bash('git fetch --all --prune'), true], ['no-history-rewrite', bash('git fetch -p origin'), true], ['no-history-rewrite', bash('git remote prune origin'), true],
  ['no-history-rewrite', bash('git fetch --all'), false], ['no-history-rewrite', bash('git fetch origin main'), false], ['no-history-rewrite', bash('git pull --prune'), true], ['no-history-rewrite', bash('git pull origin main'), false],
  ['protect-secrets', file('Read', 'C:/Users/me/proj/.env'), true], ['protect-secrets', file('Read', '.env.local'), true], ['protect-secrets', file('Read', 'src/env.ts'), false],
  ['protect-secrets', bash('cat .env'), true], ['protect-secrets', file('Read', '/home/u/.ssh/id_rsa'), true],
  ['no-sudo', bash('sudo apt update'), true], ['no-sudo', bash('echo pseudo'), false],
  ['no-installs', bash('npm install lodash'), true], ['no-installs', bash('npm run build'), false], ['no-installs', bash('pip install requests'), true],
  ['no-network', bash('curl https://x.y'), true], ['no-network', { tool: 'WebFetch', input: {}, root, cwd: root }, true],
  ['jail-writes', file('Write', 'C:/Users/me/other/a.txt'), true], ['jail-writes', file('Write', 'C:\\Users\\me\\proj\\a.txt'), false],
  ['jail-writes', file('Edit', '../escape.txt'), true], ['jail-writes', file('Edit', 'src/../ok.txt'), false], ['jail-writes', file('Write', 'c:/users/ME/proj/x'), false],
  ['jail-all', file('Read', 'C:/Windows/system.ini'), true], ['jail-all', bash('cd /tmp && ls'), true], ['jail-all', bash('cd src && ls'), false],
  ['jail-all', file('Read', 'C:/Users/me/proj-evil/x'), true],
  ['read-only', bash('git status && ls -la'), false], ['read-only', bash('echo hi > out.txt'), true], ['read-only', bash('npm test'), true], ['read-only', file('Edit', 'a.ts'), true],

  // no-mass-delete: the incident this project started from
  ['no-mass-delete', bash('oc delete --all'), true], ['no-mass-delete', bash('oc delete all --all -n team-a'), true],
  ['no-mass-delete', bash('kubectl delete pods -A'), true], ['no-mass-delete', bash('kubectl -n x delete deploy --all'), true],
  ['no-mass-delete', bash('kubectl delete namespace staging'), true], ['no-mass-delete', bash('oc delete project demo'), true],
  ['no-mass-delete', bash('helm uninstall my-release'), true], ['no-mass-delete', bash('terraform destroy -auto-approve'), true],
  ['no-mass-delete', bash('terraform apply -destroy'), true],
  ['no-mass-delete', bash('kubectl delete pod web-7d9f'), false], ['no-mass-delete', bash('kubectl get pods --all-namespaces'), false],
  ['no-mass-delete', bash('helm list'), false], ['no-mass-delete', bash('terraform plan'), false],

  // quoted prose and heredoc bodies are text, not commands
  ['no-history-rewrite', bash('node -e "s=s.replace(\'git reset --hard\', x)"'), false],
  ['no-rm-rf', bash('git commit -m "guard against rm -rf in scripts"'), false],
  ['no-mass-delete', bash("echo 'never run oc delete --all' >> NOTES.md"), false],
  ['no-rm-rf', bash("cat > notes.md <<'EOF'\nrm -rf is dangerous\nEOF"), false],

  // ...but code handed to a shell still counts, and short quoted tokens stay visible
  ['no-rm-rf', bash('bash -c "rm -rf /tmp/x"'), true], ['no-rm-rf', bash("sh -c 'rm -rf build'"), true],
  ['no-mass-delete', bash('powershell -Command "kubectl delete ns prod"'), true],
  ['no-rm-rf', bash("cat <<'EOF' | bash\nrm -rf build\nEOF"), true],
  ['no-rm-rf', bash('rm -rf "my folder"'), true], ['protect-secrets', bash('cat ".env"'), true],
]

let fail = 0
for (const [id, call, expect] of cases) {
  const got = R[id].test(call) !== undefined
  if (got !== expect) { fail++; console.log('FAIL', id, JSON.stringify(call.input), 'expected', expect) }
}

// upgrade: people on a preset get rules added later; hand-picked sets and opted-out rules are left alone
const checks = [
  ['safe-preset user gets no-mass-delete', () => mod.upgrade({ enabled: ['no-rm-rf', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo'], custom: [] }).enabled.includes('no-mass-delete')],
  ['hand-picked set unchanged', () => mod.upgrade({ enabled: ['no-rm-rf'], custom: [] }).enabled.length === 1],
  ['a rule the user turned off stays off', () => {
    const known = mod.RULES.map(r => r.id)
    return !mod.upgrade({ enabled: ['no-rm-rf', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo'], custom: [], known }).enabled.includes('no-mass-delete')
  }],
]
for (const [name, ok] of checks) if (!ok()) { fail++; console.log('FAIL upgrade:', name) }

// always on: the agent may not rewrite guardrails' own settings (#10)
const store = 'C:/Users/me/.claude/plugins/data/guardrails/store.json'
const selfCases = [
  [file('Write', store), true], [file('Edit', store.replace(/\//g, '\\')), true], [file('Read', store), false],
  [file('Edit', 'C:/Users/me/proj/plugins/guardrails/hooks/register.tsx'), false],
  [bash("sed -i 's/no-rm-rf//' ~/.claude/plugins/data/guardrails/store.json"), true],
  [bash('echo {} > ~/.claude/plugins/data/guardrails/store.json'), true],
  [bash('cp empty.json ~/.claude/plugins/data/guardrails/store.json'), true],
  [bash('cat ~/.claude/plugins/data/guardrails/store.json 2>&1'), false], [bash('npm test > out.txt'), false],
  [file('Edit', 'C:/Users/me/proj/.claude/worktrees/x/plugins/guardrails/hooks/register.tsx'), false],
  [bash('cp hooks.tsx .claude/worktrees/x/plugins/guardrails/hooks/'), false],
  [bash('rm $HOME/.claude/plugins/data/guardrails/store.json'), true],
  [bash('Set-Content C:\\Users\\me\\.claude\\plugins\\data\\guardrails\\store.json "{}"'), true],
]
for (const [call, expect] of selfCases) {
  if ((mod.protectSelf(call) !== undefined) !== expect) { fail++; console.log('FAIL protectSelf', JSON.stringify(call.input), 'expected', expect) }
}

// scripts the agent wrote are checked before they run (#10)
const p = f => `c:/users/me/proj/${f}`
const runCases = [
  ['bash cleanup.sh', [p('cleanup.sh')]], ['./run.sh && echo ok', [p('run.sh')]], ['python -u tools/x.py', [p('tools/x.py')]],
  ['FOO=1 node scripts/a.mjs', [p('scripts/a.mjs')]], ['cat cleanup.sh', []], ['npm test', []],
]
for (const [command, expect] of runCases) {
  const got = mod.scriptRuns(command, root)
  if (JSON.stringify(got) !== JSON.stringify(expect)) { fail++; console.log('FAIL scriptRuns', command, JSON.stringify(got)) }
}
const ctx = { root, cwd: root }
const scanCases = [
  ['#!/bin/bash\nset -e\nrm -rf build\necho done', ['no-rm-rf'], true],
  ['import os\nos.system("rm -rf /tmp/x")', ['no-rm-rf'], true],
  ['kubectl delete ns staging', ['no-mass-delete'], true],
  ['echo hello\nls -la', ['no-rm-rf', 'no-mass-delete'], false],
  ['rm -rf build', [], false],
]
for (const [code, enabled, expect] of scanCases) {
  if ((mod.scanScript(code, ctx, enabled) !== undefined) !== expect) { fail++; console.log('FAIL scanScript', JSON.stringify(code), 'expected', expect) }
}
const extra = [
  ['custom pattern applies inside scripts', () => mod.scanScript('docker system prune -af', ctx, [], [{ pattern: 'docker\\s+system\\s+prune', note: '' }]) !== undefined],
  ['applyEdit replaces once', () => mod.applyEdit('a a', { old_string: 'a', new_string: 'b' }) === 'b a'],
  ['applyEdit replace_all', () => mod.applyEdit('a a', { old_string: 'a', new_string: 'b', replace_all: true }) === 'b b'],
  ['applyEdit keeps $ literally', () => mod.applyEdit('x', { old_string: 'x', new_string: '$&$1' }) === '$&$1'],
  ['summarize counts the last 7 days only', () => {
    const now = 100 * 86_400_000
    const s = mod.summarize([{ at: now - 1, rule: 'A', tool: 'Bash', what: '', project: 'p' }, { at: now - 2, rule: 'A', tool: 'Bash', what: '', project: 'q' }, { at: now - 9 * 86_400_000, rule: 'B', tool: 'Bash', what: '' }], now)
    return s.total === 2 && s.byRule[0][0] === 'A' && s.byRule[0][1] === 2 && s.byProject.length === 2
  }],
]
for (const [name, ok] of extra) if (!ok()) { fail++; console.log('FAIL', name) }

const total = cases.length + checks.length + selfCases.length + runCases.length + scanCases.length + extra.length
console.log(`${total - fail}/${total} passed`)
if (fail > 0) process.exit(1)
