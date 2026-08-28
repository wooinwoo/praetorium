import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _test as patchTest, patchHermesRuntime } from '../../scripts/patch-hermes-codex-runtime.mjs';
import {
  LOCAL_BIND_ADDRESS,
  isLoopbackAddress,
  isLoopbackHost,
  resolveBindAddress,
} from '../../lib/local-only.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = path => readFileSync(resolve(root, path), 'utf8');

function loadSanitizerFromSource() {
  const workerConsole = source('src/components/WorkerConsole.jsx');
  const declaration = workerConsole.match(
    /export function sanitizeTerminalOutput\(value\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(declaration, 'sanitizeTerminalOutput must remain an exported, independently testable helper');
  return Function('value', declaration[1]);
}

describe('Worker Codex session console contract', () => {
  it('renders the real Codex session stream in xterm without exposing raw shell stdin', () => {
    const workerConsole = source('src/components/WorkerConsole.jsx');
    const manifest = JSON.parse(source('package.json'));

    assert.equal(typeof manifest.dependencies?.['@xterm/xterm'], 'string');
    assert.match(workerConsole, /from ['"]@xterm\/xterm['"]/);
    assert.match(workerConsole, /new Terminal\s*\(\s*\{[\s\S]*?disableStdin:\s*true/);
    assert.doesNotMatch(workerConsole, /\.onData\s*\(|\.onBinary\s*\(/);
    assert.match(workerConsole, /MAX_TERMINAL_WRITE_CHUNK = 64_000/);
    assert.match(workerConsole, /terminalWritePendingRef\.current/);
    assert.match(workerConsole, /terminal\.write\(chunk, \(\) =>/);
    assert.match(workerConsole, /terminal\.options\.theme = \{ \.\.\.WORKER_TERMINAL_THEME \}/);
    assert.match(workerConsole, /attributeFilter: \['style', 'data-theme'\]/);
    assert.match(source('src/styles.css'), /\.worker-output \{[^}]*color-scheme: dark/);
    assert.match(source('src/styles.css'), /\.worker-xterm \.xterm-screen, \.worker-xterm \.xterm-rows \{ color: #b8c0cc; \}/);
    assert.match(workerConsole, /실제 Codex 세션/);
    assert.match(workerConsole, /실시간 출력 · 읽기 전용 · PTY 아님/);
    assert.match(source('src/components/forms.jsx'), /현재 Codex 세션에 입력/);
    assert.match(source('src/components/forms.jsx'), /실행 중이면 turn\/steer/);
  });

  it('removes terminal control strings that can mutate browser or terminal state', () => {
    const sanitizeTerminalOutput = loadSanitizerFromSource();

    const safeSgr = '\u001b[31mred\u001b[0m';
    const hostile = [
      'before-',
      '\u001b]52;c;Y2xpcGJvYXJkLXNlY3JldA==\u0007',
      '\u001b]0;forged title\u0007',
      '\u001b]2;forged title\u001b\\',
      '\u001bP1;2|dangerous-dcs\u001b\\',
      '\u009d52;c;YzE=\u009c',
      '\u0090dangerous-c1-dcs\u009c',
      '\u009b31mforged-c1-colour',
      '\u001b[8mconcealed',
      '\u001b[>4;2mmodify-keys',
      safeSgr,
      '-after',
    ].join('');

    const sanitized = sanitizeTerminalOutput(hostile);
    assert.equal(sanitized, `before-forged-c1-colourconcealedmodify-keys${safeSgr}-after`);
    assert.doesNotMatch(sanitized, /clipboard-secret|forged title|dangerous|Y2xpcGJv/);
    assert.doesNotMatch(sanitized, /\u001b\[8m|\u001b\[>4;2m|\u009b/);
  });

  it('routes Worker and Director steering through durable APIs and keeps evidence collapsed', () => {
    const workerConsole = source('src/components/WorkerConsole.jsx');
    const forms = source('src/components/forms.jsx');

    for (const mode of ['observe', 'worker', 'director']) {
      assert.match(workerConsole, new RegExp(`['"]${mode}['"]`));
    }
    assert.match(workerConsole, /<WorkerIntervention\b/);
    assert.match(workerConsole, /<DirectorGuidance\b/);
    assert.match(forms, /\/goals\/\$\{encodeURIComponent\(goalId\)\}\/guidance/);
    assert.match(forms, /body: \{ message, deliveryMode: 'director' \}/);
    assert.match(workerConsole, /<details\b[^>]*className="worker-evidence-drawer"[^>]*>/);
    assert.match(workerConsole, /allComments\.at\(-1\)\?\.body/);
    assert.match(workerConsole, /PUBLIC OPERATIONAL TRACE · raw process output 대기/);
    assert.match(workerConsole, /rawStreamHasOutputRef\.current/);
    assert.match(workerConsole, /publicOperationalTrace\(detail\)/);
    assert.doesNotMatch(workerConsole, /<details[^>]*worker-evidence-drawer[^>]*\sopen(?:=|\s|>)/);
  });

  it('patches Hermes workers to stream the public Codex event feed and use native turn steering', () => {
    const windowsPatch = source('scripts/patch-hermes-codex-runtime.ps1');
    const portablePatch = source('scripts/patch-hermes-codex-runtime.mjs');

    for (const patch of [windowsPatch, portablePatch]) {
      assert.match(patch, /PRAETORIUM_CODEX_WORKER_CONSOLE_ENV_V1/);
      assert.match(patch, /PRAETORIUM_WORKER_CONTEXT_PROMPT_V2/);
      assert.match(patch, /PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3/);
      assert.match(patch, /PRAETORIUM_CODEX_WORKER_TRACE_BRIDGE_V1/);
      assert.match(patch, /PRAETORIUM_CODEX_NATIVE_STEER_BRIDGE_V1/);
      assert.match(patch, /PRAETORIUM_CODEX_EVENT_STEER_POLL_V1/);
      assert.match(patch, /item\/reasoning\/summaryTextDelta/);
      assert.match(patch, /item\/commandExecution\/outputDelta/);
      assert.match(patch, /turn\/plan\/updated/);
      assert.match(patch, /redirect\(note\)/);
      assert.match(patch, /inject_new_comments_from_env\(agent\)/);
      assert.match(patch, /build_worker_context/);
      assert.match(patch, /complete authoritative Director instruction/);
      assert.match(patch, /never invoke/);
      assert.match(patch, /hermes kanban through the shell/);
      assert.doesNotMatch(patch, /_praetorium_console\(params\.get\("delta"\).*item\/reasoning\/textDelta/);
    }
    assert.match(windowsPatch, /Set-PraetoriumPatchedFiles/);
    assert.match(windowsPatch, /ConvertTo-PraetoriumLf/);
    assert.doesNotMatch(windowsPatch, /WriteAllText\(\$(?:runtimeProvider|appServerClient|codexRuntime|kanbanDb|kanbanTools),/);
    assert.match(portablePatch, /const staged = new Map\(\)/);
    assert.match(portablePatch, /commitPatches\(staged\)/);
  });

  it('matches portable Hermes patches across LF and CRLF source', () => {
    const sourceText = 'before\r\nneedle one\r\nneedle two\r\nafter\r\n';
    const patched = patchTest.replaceOnce(
      sourceText,
      'needle one\nneedle two',
      'replacement one\nreplacement two',
      'line ending test',
    );
    assert.equal(patched, 'before\nreplacement one\nreplacement two\nafter\n');
  });

  it('validates every portable Hermes patch before changing source files', { skip: process.platform === 'win32' }, () => {
    const hermesRoot = mkdtempSync(join(tmpdir(), 'praetorium-hermes-patch-'));
    const agentRoot = join(hermesRoot, 'hermes-agent');
    const paths = {
      hermes: join(agentRoot, 'bin', 'hermes'),
      runtimeProvider: join(agentRoot, 'hermes_cli', 'runtime_provider.py'),
      appServerClient: join(agentRoot, 'agent', 'transports', 'codex_app_server.py'),
      codexRuntime: join(agentRoot, 'agent', 'codex_runtime.py'),
      kanbanDb: join(agentRoot, 'hermes_cli', 'kanban_db.py'),
      kanbanTools: join(agentRoot, 'tools', 'kanban_tools.py'),
    };
    try {
      for (const path of Object.values(paths)) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(paths.hermes, '', 'utf8');
      const originalProvider = '    requested_provider = resolve_requested_provider(requested)\n';
      writeFileSync(paths.runtimeProvider, originalProvider, 'utf8');
      writeFileSync(paths.appServerClient, '# incompatible Hermes layout\n', 'utf8');
      writeFileSync(paths.codexRuntime, '', 'utf8');
      writeFileSync(paths.kanbanDb, '', 'utf8');
      writeFileSync(paths.kanbanTools, '', 'utf8');

      assert.throws(
        () => patchHermesRuntime(hermesRoot, () => 'Hermes Agent v0.20.5'),
        /Director board root insertion count is 0/,
      );
      assert.equal(readFileSync(paths.runtimeProvider, 'utf8'), originalProvider);
    } finally {
      rmSync(hermesRoot, { recursive: true, force: true });
    }
  });

  it('rolls back portable Hermes patch commits and preserves a failed rollback backup', () => {
    const patchRoot = mkdtempSync(join(tmpdir(), 'praetorium-hermes-commit-'));
    const first = join(patchRoot, 'first.py');
    const second = join(patchRoot, 'second.py');
    const originals = new Map([[first, 'first original\n'], [second, 'second original\n']]);
    const staged = new Map([[first, 'first patched\n'], [second, 'second patched\n']]);
    try {
      for (const [path, sourceText] of originals) writeFileSync(path, sourceText, 'utf8');
      const failSecondCommit = (sourcePath, targetPath) => {
        if (sourcePath.endsWith('.tmp') && targetPath === second) throw new Error('forced second commit failure');
        renameSync(sourcePath, targetPath);
      };
      assert.throws(() => patchTest.commitPatches(staged, failSecondCommit), /Applied files were rolled back/);
      for (const [path, sourceText] of originals) assert.equal(readFileSync(path, 'utf8'), sourceText);
      assert.deepEqual(readdirSync(patchRoot).sort(), ['first.py', 'second.py']);

      const failCommitAndRollback = (sourcePath, targetPath) => {
        if (sourcePath.endsWith('.tmp') && targetPath === second) throw new Error('forced second commit failure');
        if (sourcePath.endsWith('.bak') && targetPath === first) throw new Error('forced rollback failure');
        renameSync(sourcePath, targetPath);
      };
      assert.throws(() => patchTest.commitPatches(staged, failCommitAndRollback), /Rollback failed for/);
      const backups = readdirSync(patchRoot).filter(name => name.endsWith('.bak'));
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(patchRoot, backups[0]), 'utf8'), originals.get(first));
    } finally {
      rmSync(patchRoot, { recursive: true, force: true });
    }
  });

  it('rolls back Windows Hermes patch commits and preserves a failed rollback backup', { skip: process.platform !== 'win32' }, () => {
    const windowsPatch = source('scripts/patch-hermes-codex-runtime.ps1');
    const functionStart = windowsPatch.indexOf('function ConvertTo-PraetoriumLf');
    const functionEnd = windowsPatch.indexOf('$HermesRoot =', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const transactionFunction = windowsPatch.slice(functionStart, functionEnd);
    const exercise = String.raw`
$root = Join-Path ([IO.Path]::GetTempPath()) "praetorium-patch-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
$first = Join-Path $root 'first.py'
$second = Join-Path $root 'second.py'
try {
    $crlf = 'first' + [char]13 + [char]10 + 'second'
    $lf = 'first' + [char]10 + 'second'
    if ((ConvertTo-PraetoriumLf $crlf) -ne $lf) { throw 'CRLF normalization failed.' }
    [IO.File]::WriteAllText($first, 'first original' + [Environment]::NewLine)
    [IO.File]::WriteAllText($second, 'second original' + [Environment]::NewLine)
    $files = [ordered]@{
        $first = 'first patched' + [Environment]::NewLine
        $second = 'second patched' + [Environment]::NewLine
    }
    $script:commitCount = 0
    $failSecond = {
        param($temporary, $path, $backup)
        $script:commitCount++
        if ($script:commitCount -eq 2) { throw 'forced second commit failure' }
        [IO.File]::Replace($temporary, $path, $backup, $true)
    }
    $failed = $false
    try { $null = Set-PraetoriumPatchedFiles -Files $files -ReplaceFile $failSecond }
    catch { $failed = $true; if ($_.Exception.Message -notmatch 'Applied files were rolled back') { throw } }
    if (-not $failed) { throw 'Expected the second commit to fail.' }
    if ([IO.File]::ReadAllText($first) -ne ('first original' + [Environment]::NewLine)) { throw 'First file was not rolled back.' }
    if ([IO.File]::ReadAllText($second) -ne ('second original' + [Environment]::NewLine)) { throw 'Second file changed.' }
    if (@(Get-ChildItem -LiteralPath $root -Filter '*.bak').Count) { throw 'Successful rollback left a backup.' }

    $script:commitCount = 0
    $failRestore = { param($backup, $path) throw 'forced rollback failure' }
    $failed = $false
    try { $null = Set-PraetoriumPatchedFiles -Files $files -ReplaceFile $failSecond -RestoreFile $failRestore }
    catch { $failed = $true; if ($_.Exception.Message -notmatch 'Rollback failed for') { throw } }
    if (-not $failed) { throw 'Expected rollback to fail.' }
    $backups = @(Get-ChildItem -LiteralPath $root -Filter '*.bak')
    if ($backups.Count -ne 1) { throw "Expected one recovery backup, got $($backups.Count)." }
    if ([IO.File]::ReadAllText($backups[0].FullName) -ne ('first original' + [Environment]::NewLine)) { throw 'Recovery backup lost the original.' }
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
`;
    const command = Buffer.from(`${transactionFunction}\n${exercise}`, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('distinguishes an in-flight pause from a confirmed Owner pause', () => {
    const workerConsole = source('src/components/WorkerConsole.jsx');

    assert.match(workerConsole, /const pausePending = !pausedByOwner && Boolean/);
    assert.match(workerConsole, /const resumePending = pausedByOwner && Boolean/);
    assert.match(workerConsole, /pausePending[\s\S]{0,240}정지 요청 중/);
    assert.match(workerConsole, /pausedByOwner[\s\S]{0,240}Owner가 일시정지/);
    assert.match(workerConsole, /Director 관리/);
  });

  it('does not let Workspace Escape close through an open native dialog', () => {
    const workspace = source('src/components/Workspace.jsx');
    const forms = source('src/components/forms.jsx');

    assert.match(forms, /<dialog\b/);
    assert.match(workspace, /document\.querySelector\(['"]dialog\[open\], \[role="dialog"\]['"]\)/);
  });

  it('keeps the complete Goal trace reachable from the unified project room', () => {
    const workspace = source('src/components/Workspace.jsx');

    assert.match(workspace, /function ProcessJournal[\s\S]*useState\(160\)/);
    assert.match(workspace, /trace\.slice\(-traceLimit\)/);
    assert.match(workspace, /이전 \{Math\.min\(160, omitted\)\}개 불러오기/);
    assert.match(workspace, /<section className="process-journal" aria-label="전체 작업 과정">/);
    assert.doesNotMatch(workspace, /trace\.slice\(-10\)/);
  });

  it('adds no raw stdin, PTY, WebSocket, or shell-control API', () => {
    const server = source('server.js');
    const routes = source('routes/directors.js');
    const manifest = JSON.parse(source('package.json'));
    const routePaths = [...routes.matchAll(/addRoute\(\s*['"][A-Z]+['"]\s*,\s*['"]([^'"]+)['"]/g)]
      .map(match => match[1]);

    assert.deepEqual(routePaths.filter(path => /(?:^|\/)(?:pty|stdin)(?:\/|$)|terminal.*(?:input|write)/i.test(path)), []);
    assert.doesNotMatch(`${server}\n${routes}`, /node-pty|@tauri-apps\/plugin-shell|new WebSocket\s*\(/i);
    assert.equal(manifest.dependencies?.['node-pty'], undefined);
    assert.equal(manifest.dependencies?.['@tauri-apps/plugin-shell'], undefined);
  });

  it('preserves the loopback-only server boundary', () => {
    const server = source('server.js');

    assert.equal(LOCAL_BIND_ADDRESS, '127.0.0.1');
    assert.equal(resolveBindAddress('0.0.0.0'), '127.0.0.1');
    assert.equal(isLoopbackAddress('192.168.0.10'), false);
    assert.equal(isLoopbackHost('workstation.example:3848'), false);
    assert.match(server, /!isLoopbackAddress\(req\.socket\.remoteAddress\) \|\| !isLoopbackHost\(req\.headers\.host\)/);
    assert.match(server, /server\.listen\(PORT, LOCAL_BIND_ADDRESS/);
    assert.match(server, /trace-stream['"], async \(req, res\) => \{[\s\S]*?!isLocalDirectorRequest\(req\)/);
    assert.match(server, /api\/system\/shutdown[\s\S]*?directorActivityStream\.close\(\);[\s\S]*?workerTraceStream\.close\(\);/);
  });
});
