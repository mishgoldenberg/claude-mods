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
  ['no-rm-rf', bash('Remove-Item -Recurse -Force .\dist'), true], ['no-rm-rf', bash('rm file.txt'), false], ['no-rm-rf', bash('rm -r dir'), false],
  ['no-force-push', bash('git push --force origin main'), true], ['no-force-push', bash('git push -f'), true],
  ['no-force-push', bash('git push --force-with-lease'), false], ['no-force-push', bash('git push origin main'), false],
  ['no-history-rewrite', bash('git reset --hard HEAD~1'), true], ['no-history-rewrite', bash('git clean -fd'), true], ['no-history-rewrite', bash('git reset HEAD file'), false],
  ['protect-secrets', file('Read', 'C:/Users/me/proj/.env'), true], ['protect-secrets', file('Read', '.env.local'), true], ['protect-secrets', file('Read', 'src/env.ts'), false],
  ['protect-secrets', bash('cat .env'), true], ['protect-secrets', file('Read', '/home/u/.ssh/id_rsa'), true],
  ['no-sudo', bash('sudo apt update'), true], ['no-sudo', bash('echo pseudo'), false],
  ['no-installs', bash('npm install lodash'), true], ['no-installs', bash('npm run build'), false], ['no-installs', bash('pip install requests'), true],
  ['no-network', bash('curl https://x.y'), true], ['no-network', { tool: 'WebFetch', input: {}, root, cwd: root }, true],
  ['jail-writes', file('Write', 'C:/Users/me/other/a.txt'), true], ['jail-writes', file('Write', 'C:\Users\me\proj\a.txt'), false],
  ['jail-writes', file('Edit', '../escape.txt'), true], ['jail-writes', file('Edit', 'src/../ok.txt'), false], ['jail-writes', file('Write', 'c:/users/ME/proj/x'), false],
  ['jail-all', file('Read', 'C:/Windows/system.ini'), true], ['jail-all', bash('cd /tmp && ls'), true], ['jail-all', bash('cd src && ls'), false],
  ['jail-all', file('Read', 'C:/Users/me/proj-evil/x'), true],
  ['read-only', bash('git status && ls -la'), false], ['read-only', bash('echo hi > out.txt'), true], ['read-only', bash('npm test'), true], ['read-only', file('Edit', 'a.ts'), true],
]
let fail = 0
for (const [id, call, expect] of cases) {
  const got = R[id].test(call) !== undefined
  if (got !== expect) { fail++; console.log('FAIL', id, JSON.stringify(call.input), 'expected', expect) }
}
console.log(`${cases.length - fail}/${cases.length} passed`)
if (fail > 0) process.exit(1)
