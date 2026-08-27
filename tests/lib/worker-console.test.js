import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
