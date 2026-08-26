import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus, homedir, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { PINNED_CODEX_VERSION, PINNED_HERMES_VERSION, WslRuntime } from './wsl-runtime.js';
import { snapshotWindowsCandidate } from './candidate-snapshot.js';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const KANBAN_TIMEOUT_MS = 30000;
const DIRECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const RUNTIME_TARGET_CACHE_MS = 60 * 1000;
const REMOTE_ENV_PREFIX = /^(?:API_SERVER_|WEBHOOK_|GATEWAY_|RELAY_|TELEGRAM_|DISCORD_|SLACK_|WHATSAPP_|MATRIX_|MATTERMOST_|SIGNAL_|IMESSAGE_|EMAIL_|QQ_|LINE_|DINGTALK_|WECOM_|MSTEAMS_|MS_TEAMS_)/i;
const SENSITIVE_ENV_WORD = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|CLIENT_SECRET|SESSION_TOKEN|ACCESS_KEY(?:_ID)?|API_KEY|AUTH_TOKEN|AUTH)(?:_|$)/i;
const SENSITIVE_ENV_EXACT = new Set([
  'DOCKER_AUTH_CONFIG', 'DOCKER_CONFIG', 'GIT_ASKPASS', 'KUBECONFIG',
  'NETRC', 'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);
const SENSITIVE_ENV_VALUE = /^(?:DATABASE_URL|MONGODB_URI|MYSQL_PWD|PGPASSWORD|REDIS_URL)$/i;
const PROCESS_LEASE_SCHEMA = 'praetorium-process-lease.v1';
const LEASE_GUARD_ATTEMPTS = 100;
const LEASE_GUARD_WAIT_MS = 10;

function assertSafeId(value, label) {
  if (!SAFE_ID.test(value || '')) throw new Error(`Invalid ${label}`);
}

function parseLastJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Hermes may print a short preamble. */ }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

function parseChatOutput(text) {
  let sessionId = null;
  const output = String(text || '').split(/\r?\n/).filter(line => {
    const match = line.trim().match(/^(?:session_id:\s*|SESSION_ID=)([a-z0-9_-]+)$/i);
    if (!match) return true;
    sessionId = match[1];
    return false;
  }).join('\n').trim();
  return { sessionId, output };
}

function isSensitiveEnvKey(key) {
  const normalized = String(key || '').trim().toUpperCase();
  if (!normalized) return false;
  return normalized.startsWith('AWS_')
    || SENSITIVE_ENV_EXACT.has(normalized)
    || SENSITIVE_ENV_WORD.test(normalized)
    || SENSITIVE_ENV_VALUE.test(normalized);
}

function localOnlyEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => (
    !REMOTE_ENV_PREFIX.test(key) && !isSensitiveEnvKey(key)
  )));
  return {
    ...env,
    API_SERVER_ENABLED: 'false',
    WEBHOOK_ENABLED: 'false',
    GATEWAY_ALLOW_ALL_USERS: 'false',
    WHATSAPP_ENABLED: 'false',
  };
}

function processIsAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processIdentity(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script = `$process = Get-Process -Id ${numeric} -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)`;
      const configuredRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const windowsRoot = win32.isAbsolute(configuredRoot) ? configuredRoot : 'C:\\Windows';
      const powershell = win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = spawnSync(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 16384 });
      const ticks = String(result.stdout || '').trim();
      return result.status === 0 && /^\d+$/.test(ticks) ? `windows-start-ticks:${ticks}` : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${numeric}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(numeric)], {
      encoding: 'utf8', timeout: 3000,
    });
    const startedAt = String(result.stdout || '').trim();
    return result.status === 0 && startedAt ? `${process.platform}-start:${startedAt}` : null;
  } catch {
    return null;
  }
}

function safeProcessIdentity(getIdentity, pid) {
  try {
    const identity = getIdentity(pid);
    return identity === null || identity === undefined || identity === '' ? null : String(identity);
  } catch {
    return null;
  }
}

function windowsIdentityStartedAfter(identity, createdAt) {
  const match = String(identity || '').match(/^windows-start-ticks:(\d+)$/);
  const createdAtMs = Date.parse(String(createdAt || ''));
  if (!match || !Number.isFinite(createdAtMs)) return false;
  try {
    const createdAtTicks = (BigInt(Math.trunc(createdAtMs)) * 10000n) + 621355968000000000n;
    return BigInt(match[1]) > createdAtTicks;
  } catch {
    return false;
  }
}

function ownerIsAlive(owner, { isAlive, getIdentity }) {
  if (!owner || !isAlive(owner.pid)) return false;
  const currentIdentity = safeProcessIdentity(getIdentity, owner.pid);
  if (!owner.processIdentity) {
    // v2.1 owners predate explicit identities. Windows process creation time is
    // still enough to prove reuse when the live process started after the lease.
    return currentIdentity === null
      || !windowsIdentityStartedAfter(currentIdentity, owner.createdAt);
  }
  // Identity lookup failure must not let a second writer in. A concrete mismatch,
  // however, proves that a live PID has been reused by a different process.
  return currentIdentity === null || currentIdentity === owner.processIdentity;
}

function readOwnerDocument(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    return owner && owner.schema === PROCESS_LEASE_SCHEMA && typeof owner.token === 'string'
      ? owner : null;
  } catch {
    return null;
  }
}

function readOwnerFile(path) {
  const owner = readOwnerDocument(path);
  return owner?.kind === 'released' || owner?.released === true ? null : owner;
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, milliseconds));
}

function writeDurableFile(path, contents, flags = 'w') {
  let descriptor = null;
  try {
    descriptor = openSync(path, flags, 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readGuardJournal(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { active: null, records: [], corrupt: false };
    throw error;
  }
  const records = [];
  let sawValidRecord = false;
  let corrupt = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch {
      // A torn final append is recoverable after at least one durable record.
      // An unknown/corrupt pre-journal guard remains fail-closed.
      if (!sawValidRecord) corrupt = true;
      continue;
    }
    if (record?.schema !== PROCESS_LEASE_SCHEMA || typeof record.token !== 'string') {
      if (!sawValidRecord) corrupt = true;
      continue;
    }
    sawValidRecord = true;
    records.push(record);
  }
  if (!sawValidRecord && text.trim()) corrupt = true;
  let active = null;
  for (const record of records) {
    if (record.op === 'release') {
      if (active?.token === record.token) active = null;
      continue;
    }
    if (record.op === 'claim') {
      const expected = record.expectedToken ?? null;
      if ((active?.token ?? null) === expected) active = record;
      continue;
    }
    // A v2.1 guard was a single owner document without an operation.
    if (!active && record.kind === 'guard') active = record;
  }
  return { active, records, corrupt };
}

function appendGuardRecord(path, record) {
  // One O_APPEND write is the journal's linearization point. Competing stale
  // recoveries may both append, but only the first matching expectedToken wins.
  // Records intentionally remain append-only (four short records per clean
  // process lifecycle); replacing/compacting this file would reintroduce the
  // stale-owner token -> unlink/replace race this journal removes.
  writeDurableFile(path, `\n${JSON.stringify(record)}\n`, 'a');
}

function releaseLeaseGuard(guardFile, owner) {
  appendGuardRecord(guardFile, {
    schema: PROCESS_LEASE_SCHEMA,
    kind: 'guard',
    op: 'release',
    pid: owner.pid,
    token: owner.token,
    processIdentity: owner.processIdentity || null,
    releasedAt: new Date().toISOString(),
  });
  return readGuardJournal(guardFile).active?.token !== owner.token;
}

function acquireLeaseGuard(guardFile, { pid, isAlive, getIdentity }) {
  for (let attempt = 0; attempt < LEASE_GUARD_ATTEMPTS; attempt += 1) {
    const journal = readGuardJournal(guardFile);
    if (journal.corrupt) {
      const corruptError = new Error('Praetorium process lease guard is corrupt; refusing concurrent recovery.');
      corruptError.code = 'PRAETORIUM_LEASE_GUARD_CORRUPT';
      throw corruptError;
    }
    const existing = journal.active;
    if (existing && ownerIsAlive(existing, { isAlive, getIdentity })) {
      sleepSync(LEASE_GUARD_WAIT_MS);
      continue;
    }
    const owner = {
      schema: PROCESS_LEASE_SCHEMA,
      kind: 'guard',
      op: 'claim',
      expectedToken: existing?.token || null,
      pid,
      token: randomUUID(),
      processIdentity: safeProcessIdentity(getIdentity, pid),
      createdAt: new Date().toISOString(),
    };
    appendGuardRecord(guardFile, owner);
    if (readGuardJournal(guardFile).active?.token === owner.token) return owner;
    sleepSync(LEASE_GUARD_WAIT_MS);
  }
  const error = new Error('Praetorium process lease recovery is already in progress.');
  error.code = 'PRAETORIUM_LEASE_BUSY';
  throw error;
}

export function acquireProcessLease({
  leaseFile, pid = process.pid, isAlive = processIsAlive, getIdentity,
} = {}) {
  const requestedPath = String(leaseFile || '');
  if (!requestedPath || (!isAbsolute(requestedPath) && !win32.isAbsolute(requestedPath))) {
    throw new Error('Process lease file must be absolute.');
  }
  const path = resolve(requestedPath);
  mkdirSync(dirname(path), { recursive: true });
  const guardFile = `${path}.guard`;
  const identityReader = getIdentity || (isAlive === processIsAlive ? processIdentity : () => null);
  const beforeGuard = readOwnerFile(path);
  if (beforeGuard && ownerIsAlive(beforeGuard, { isAlive, getIdentity: identityReader })) {
    const error = new Error(`Praetorium is already running with PID ${beforeGuard.pid}.`);
    error.code = 'PRAETORIUM_LEASE_HELD';
    error.owner = beforeGuard;
    throw error;
  }
  const guard = acquireLeaseGuard(guardFile, { pid, isAlive, getIdentity: identityReader });
  let recovered = null;
  try {
    const document = readOwnerDocument(path);
    const existing = document?.kind === 'released' || document?.released === true ? null : document;
    if (existing && ownerIsAlive(existing, { isAlive, getIdentity: identityReader })) {
      const error = new Error(`Praetorium is already running with PID ${existing.pid}.`);
      error.code = 'PRAETORIUM_LEASE_HELD';
      error.owner = existing;
      throw error;
    }
    if (existsSync(path)) {
      recovered = existing || (document ? null : { pid: null, token: null, corrupt: true });
    }
    const owner = {
      schema: PROCESS_LEASE_SCHEMA,
      kind: 'server',
      pid,
      token: randomUUID(),
      processIdentity: guard.processIdentity,
      createdAt: new Date().toISOString(),
    };
    // The append-only guard journal serializes this snapshot write. Stale files
    // are overwritten in place, never removed after a token-check TOCTOU window.
    writeDurableFile(path, `${JSON.stringify(owner)}\n`);
    let released = false;
    return {
      path,
      owner,
      recovered,
      release() {
        if (released) return false;
        const releaseGuard = acquireLeaseGuard(guardFile, { pid, isAlive, getIdentity: identityReader });
        try {
          const current = readOwnerFile(path);
          const removed = current?.token === owner.token;
          if (removed) writeDurableFile(path, `${JSON.stringify({
            ...owner, kind: 'released', released: true, releasedAt: new Date().toISOString(),
          })}\n`);
          released = true;
          return removed;
        }
        finally { releaseLeaseGuard(guardFile, releaseGuard); }
      },
    };
  } finally {
    releaseLeaseGuard(guardFile, guard);
  }
}

function hermesRootFromExecutable(executable) {
  const pathApi = win32.isAbsolute(executable) ? win32 : { basename, dirname, resolve };
  const executableDir = pathApi.dirname(pathApi.resolve(executable));
  const container = pathApi.basename(executableDir).toLowerCase();
  if (container === 'scripts') return pathApi.resolve(executableDir, '..', '..', '..');
  if (container === 'bin') {
    return pathApi.basename(pathApi.dirname(executableDir)).toLowerCase() === 'venv'
      ? pathApi.resolve(executableDir, '..', '..', '..')
      : pathApi.resolve(executableDir, '..', '..');
  }
  throw new Error('Hermes executable must be inside hermes-agent/venv/Scripts or hermes-agent/bin');
}

function runtimeTarget(value) {
  if (value?.kind === 'wsl') return { kind: 'wsl', distro: value.distro };
  return { kind: 'windows', distro: null };
}

function executableVersion(spawnImpl, executable, args = ['--version'], timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    let settled = false;
    child.stdout?.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { error += chunk.toString('utf8'); });
    child.once('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve((output || error).trim());
      else reject(new Error(error.trim() || `${executable} exited with code ${code}`));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${executable} version check timed out`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export function adaptiveWorkerLimit({ ready = 0, running = 0, cpuCount = cpus().length, memoryBytes = totalmem() } = {}) {
  if (ready <= 0) return 0;
  const cpuBudget = Math.max(2, Math.floor(Math.max(1, cpuCount) * 0.75));
  const memoryBudget = Math.max(2, Math.floor(memoryBytes / (3 * 1024 ** 3)));
  const capacity = Math.max(0, Math.min(12, cpuBudget, memoryBudget) - Math.max(0, running));
  return Math.min(ready, capacity);
}

export class HermesRuntime {
  constructor({
    hermesBin = process.env.HERMES_BIN || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'hermes-agent', 'bin', 'hermes.exe'),
    spawnImpl = spawn,
    wslRuntime = null,
    timeoutMs = 90 * 60 * 1000,
    directorTimeoutMs = Number(process.env.PRAETORIUM_DIRECTOR_TIMEOUT_MS) || DIRECTOR_TIMEOUT_MS,
  } = {}) {
    this.hermesBin = hermesBin;
    this.spawnImpl = spawnImpl;
    this.wslRuntime = wslRuntime || new WslRuntime({ spawnImpl });
    this.timeoutMs = timeoutMs;
    this.directorTimeoutMs = directorTimeoutMs;
    this.runtimeTargetsCache = null;
    this.runtimeTargetsProbe = null;
  }

  async run(args, { cwd, board, input = null, timeoutMs = this.timeoutMs, onOutput = null, directorMode = false, target = null } = {}) {
    if (!Array.isArray(args) || !args.length) return Promise.reject(new Error('Hermes arguments are required'));
    const selectedTarget = runtimeTarget(target);
    if (cwd && selectedTarget.kind === 'windows' && !isAbsolute(cwd) && !win32.isAbsolute(cwd)) return Promise.reject(new Error('Hermes cwd must be absolute'));

    const targetEnv = {
      ...(cwd ? {
        TERMINAL_CWD: cwd,
        PRAETORIUM_PROJECT_CWD: cwd,
      } : {}),
      ...(directorMode ? { PRAETORIUM_DIRECTOR_MODE: 'true' } : {}),
    };
    let executable = this.hermesBin;
    let executableArgs = args;
    let spawnCwd = cwd || process.cwd();
    let spawnEnv = {
      ...localOnlyEnv(),
      ...targetEnv,
      ...(board ? {
        HERMES_KANBAN_BOARD: board,
        HERMES_KANBAN_DB: join(hermesRootFromExecutable(this.hermesBin), 'kanban', 'boards', board, 'kanban.db').replaceAll('\\', '/'),
      } : {}),
    };
    if (selectedTarget.kind === 'wsl') {
      const launch = await this.wslRuntime.launch({
        distro: selectedTarget.distro,
        cwd,
        args,
        board,
        env: {
          API_SERVER_ENABLED: 'false',
          WEBHOOK_ENABLED: 'false',
          GATEWAY_ALLOW_ALL_USERS: 'false',
          WHATSAPP_ENABLED: 'false',
          ...(board ? { HERMES_KANBAN_BOARD: board } : {}),
          ...targetEnv,
        },
      });
      executable = launch.executable;
      executableArgs = launch.args;
      spawnCwd = launch.cwd;
      spawnEnv = localOnlyEnv();
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(executable, executableArgs, {
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
        env: spawnEnv,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let exitTimer = null;
      const append = (channel, chunk) => {
        const text = chunk.toString('utf8');
        if (channel === 'stdout') stdout = (stdout + text).slice(-MAX_CAPTURE_BYTES);
        else stderr = (stderr + text).slice(-MAX_CAPTURE_BYTES);
        onOutput?.({ channel, text });
      };
      child.stdout?.on('data', chunk => append('stdout', chunk));
      child.stderr?.on('data', chunk => append('stderr', chunk));
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitTimer) clearTimeout(exitTimer);
        reject(err);
      });
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitTimer) clearTimeout(exitTimer);
        const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim(), json: parseLastJson(stdout) };
        if (code === 0) resolve(result);
        else reject(Object.assign(new Error(stderr.trim() || `Hermes exited with code ${code}`), { result }));
      };
      child.on('close', finish);
      // On Windows a Hermes child can exit while a grandchild MCP process
      // still owns an inherited stdout/stderr handle. Node's `close` then never
      // arrives even though the actual Director is gone. `exit` is the process
      // lifecycle authority; allow a brief drain window, then settle anyway.
      child.on('exit', (code, signal) => {
        if (settled || exitTimer) return;
        exitTimer = setTimeout(() => finish(code, signal), 150);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (exitTimer) clearTimeout(exitTimer);
        child.kill();
        reject(Object.assign(new Error(`Hermes timed out after ${timeoutMs}ms`), { code: 'HERMES_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();

      if (input !== null) child.stdin?.end(String(input));
      else child.stdin?.end();
    });
  }

  async chat({ profile, session = null, cwd, board, prompt, onOutput, target }) {
    assertSafeId(profile, 'profile');
    if (session) assertSafeId(session, 'session');
    if (!String(prompt || '').trim()) return Promise.reject(new Error('Prompt is required'));
    const args = [
      '-p', profile,
      'chat', '--query-file', '-', '--quiet',
      '--in', cwd,
      '--skills', profile === 'skill-director' ? 'skill-director' : 'project-director',
      '--source', 'tool',
      '--max-turns', '500',
      '--run-budget', '5400',
    ];
    if (session) args.push('--resume', session, '--no-restore-cwd');

    // Hermes v0.20.5 can leave the first request to a newly-created named
    // `--continue --create-if-missing` session waiting indefinitely before the
    // model call. Start normally, capture Hermes' real session ID, and resume
    // that ID on later owner messages instead.
    const result = await this.run(args, {
      cwd, board, input: prompt, onOutput, timeoutMs: this.directorTimeoutMs, directorMode: true, target,
    });
    const parsed = parseChatOutput(result.stdout);
    const stderrMeta = parseChatOutput(result.stderr);
    if (!parsed.output) {
      throw Object.assign(new Error('Hermes Director returned no output; the local Codex runtime did not complete a valid turn.'), { result });
    }
    return {
      ...result,
      rawStdout: result.stdout,
      stdout: parsed.output,
      sessionId: parsed.sessionId || stderrMeta.sessionId || session || null,
    };
  }

  async resolveReadOnlyPath({ path, target }) {
    const source = String(path || '');
    if (!source || (!isAbsolute(source) && !win32.isAbsolute(source))) {
      throw new Error('Director attachment path must be absolute');
    }
    const selectedTarget = runtimeTarget(target);
    if (selectedTarget.kind !== 'wsl') return win32.isAbsolute(source) ? win32.normalize(source) : resolve(source);
    const converted = await this.wslRuntime.toWslPath(selectedTarget.distro, source);
    if (!posix.isAbsolute(converted)) throw new Error('WSL attachment path conversion did not return an absolute path');
    return posix.normalize(converted);
  }

  kanban({ profile, board, args, cwd, timeoutMs = KANBAN_TIMEOUT_MS, target }) {
    assertSafeId(profile, 'profile');
    assertSafeId(board, 'board');
    return this.run(['-p', profile, 'kanban', '--board', board, ...args], { cwd, board, timeoutMs, target });
  }

  async ensureBoard({ profile, board, cwd, name = board, target }) {
    assertSafeId(profile, 'profile');
    assertSafeId(board, 'board');
    const listed = await this.run(['-p', profile, 'kanban', 'boards', 'list', '--json'], { cwd, timeoutMs: KANBAN_TIMEOUT_MS, target });
    const boards = Array.isArray(listed.json) ? listed.json : listed.json?.boards || [];
    if (!boards.some(item => (item.slug || item.id) === board)) {
      await this.run([
        '-p', profile, 'kanban', 'boards', 'create', board,
        '--name', String(name).slice(0, 100), '--default-workdir', cwd,
      ], { cwd, timeoutMs: KANBAN_TIMEOUT_MS, target });
    }
    await this.kanban({ profile, board, cwd, args: ['init'], target });
  }

  async listTasks({ profile, board, cwd, target }) {
    const result = await this.kanban({ profile, board, cwd, args: ['list', '--json'], target });
    const payload = result.json;
    if (Array.isArray(payload)) return payload;
    return payload?.tasks || [];
  }

  async taskDetails({ profile, board, cwd, taskId, target }) {
    assertSafeId(taskId, 'task');
    const result = await this.kanban({ profile, board, cwd, args: ['show', taskId, '--json'], target });
    return result.json || null;
  }

  async taskLog({ profile, board, cwd, taskId, tail = 120000, target }) {
    assertSafeId(taskId, 'task');
    const bytes = Math.max(1000, Math.min(500000, Number(tail) || 120000));
    const result = await this.kanban({
      profile, board, cwd, args: ['log', taskId, '--tail', String(bytes)], target,
    });
    return result.stdout || '';
  }

  async commentTask({ profile, board, cwd, taskId, message, author = 'Owner', target }) {
    assertSafeId(taskId, 'task');
    const body = String(message || '').trim();
    if (!body) throw new Error('Intervention message is required');
    return this.kanban({
      profile,
      board,
      cwd,
      target,
      args: ['comment', taskId, body.slice(0, 12000), '--author', String(author || 'Owner').slice(0, 80)],
    });
  }

  async reclaimTask({ profile, board, cwd, taskId, reason = 'Paused by Owner', target }) {
    assertSafeId(taskId, 'task');
    return this.kanban({
      profile, board, cwd, args: ['reclaim', taskId, '--reason', String(reason).slice(0, 500)], target,
    });
  }

  async blockTask({ profile, board, cwd, taskId, reason = 'Paused by Owner', target }) {
    assertSafeId(taskId, 'task');
    return this.kanban({
      profile, board, cwd,
      args: ['block', taskId, String(reason).slice(0, 2000), '--kind', 'needs_input'], target,
    });
  }

  async unblockTask({ profile, board, cwd, taskId, target }) {
    assertSafeId(taskId, 'task');
    return this.kanban({ profile, board, cwd, args: ['unblock', taskId], target });
  }

  dispatch({ profile, board, cwd, max, target }) {
    const numeric = Number(max);
    const limit = Math.max(0, Math.min(12, Number.isFinite(numeric) ? numeric : 1));
    return this.kanban({ profile, board, cwd, args: ['dispatch', '--max', String(limit), '--json'], target });
  }

  createObjective({ profile, board, cwd, title, body, target }) {
    return this.kanban({
      profile,
      board,
      cwd,
      args: [
        'create', String(title).slice(0, 160),
        '--body', String(body || ''),
        '--assignee', profile,
        '--workspace', `dir:${cwd}`,
        '--created-by', 'owner-console',
        '--skill', 'project-director',
        '--goal', '--goal-max-turns', '20',
        '--json',
      ],
      target,
    });
  }

  createTask({
    profile, board, cwd, title, body, assignee, skills = [], parents = [],
    idempotencyKey, goalMode = false, goalMaxTurns = 12, target,
  }) {
    assertSafeId(assignee, 'assignee');
    const args = [
      'create', String(title).slice(0, 160),
      '--body', String(body || ''),
      '--assignee', assignee,
      '--workspace', `dir:${cwd}`,
      '--created-by', 'praetorium-director',
      '--max-runtime', '45m',
      '--max-retries', '2',
    ];
    for (const parent of parents) {
      assertSafeId(parent, 'parent task');
      args.push('--parent', parent);
    }
    for (const skill of skills) {
      assertSafeId(skill, 'skill');
      args.push('--skill', skill);
    }
    if (goalMode) args.push('--goal', '--goal-max-turns', String(Math.max(1, Math.min(50, Number(goalMaxTurns) || 12))));
    if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 160));
    args.push('--json');
    return this.kanban({ profile, board, cwd, args, target });
  }

  candidateSnapshot({ cwd, target, declaredPaths = [] }) {
    const selectedTarget = runtimeTarget(target);
    if (selectedTarget.kind === 'wsl') {
      return this.wslRuntime.candidateSnapshot({
        distro: selectedTarget.distro, path: cwd, declaredPaths,
      });
    }
    return snapshotWindowsCandidate({ cwd, spawnImpl: this.spawnImpl, declaredPaths });
  }

  async describeTargets({ force = false } = {}) {
    const cached = this.runtimeTargetsCache;
    if (!force && cached && Date.now() - cached.checkedAt < RUNTIME_TARGET_CACHE_MS) {
      return structuredClone(cached.value);
    }
    const active = this.runtimeTargetsProbe;
    if (active) {
      if (!force || active.force) return active.promise.then(value => structuredClone(value));
      active.forced ||= active.promise.catch(() => {}).then(() => this.describeTargets({ force: true }));
      return active.forced.then(value => structuredClone(value));
    }
    const probe = { force, promise: null, forced: null };
    probe.promise = this._describeTargetsFresh({ force }).then(value => {
      this.runtimeTargetsCache = { checkedAt: Date.now(), value };
      return value;
    }).finally(() => {
      if (this.runtimeTargetsProbe === probe) this.runtimeTargetsProbe = null;
    });
    this.runtimeTargetsProbe = probe;
    return probe.promise.then(value => structuredClone(value));
  }

  async _describeTargetsFresh({ force = false } = {}) {
    let root = null;
    let profiles = [];
    try {
      root = hermesRootFromExecutable(this.hermesBin);
      const profilesRoot = join(root, 'profiles');
      if (existsSync(profilesRoot)) profiles = readdirSync(profilesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    } catch { /* custom development binaries may not use the managed layout */ }

    const windowsProbe = Promise.allSettled([
      this.run(['--version'], { timeoutMs: 10000 }),
      executableVersion(this.spawnImpl, process.env.CODEX_BIN || 'codex'),
      executableVersion(this.spawnImpl, process.env.CODEX_BIN || 'codex', ['login', 'status']),
    ]);
    const wslProbe = this.wslRuntime.listTargets({ force })
      .then(targets => ({ targets, error: null }))
      .catch(error => ({ targets: [], error: error.message }));
    const [[hermesCheck, codexCheck, codexAuthCheck], wslResult] = await Promise.all([windowsProbe, wslProbe]);
    const hermesVersion = hermesCheck.status === 'fulfilled' ? (hermesCheck.value.stdout || hermesCheck.value.stderr) : null;
    const codexVersion = codexCheck.status === 'fulfilled' ? codexCheck.value : null;
    const windows = {
      id: 'windows', kind: 'windows', distro: null, label: 'Windows', checkedAt: Date.now(),
      ready: Boolean(hermesVersion?.includes(PINNED_HERMES_VERSION) && codexVersion?.includes(PINNED_CODEX_VERSION) && codexAuthCheck.status === 'fulfilled'),
      hermes: { installed: Boolean(hermesVersion), path: this.hermesBin, version: hermesVersion, pinned: Boolean(hermesVersion?.includes(PINNED_HERMES_VERSION)) },
      codex: { installed: Boolean(codexVersion), path: process.env.CODEX_BIN || 'codex', version: codexVersion, pinned: Boolean(codexVersion?.includes(PINNED_CODEX_VERSION)), authenticated: codexAuthCheck.status === 'fulfilled' },
      profiles,
      error: hermesCheck.status === 'rejected' ? hermesCheck.reason.message : codexCheck.status === 'rejected' ? codexCheck.reason.message : codexAuthCheck.status === 'rejected' ? 'Windows Codex 로그인이 필요합니다.' : null,
    };
    return {
      targets: [windows, ...wslResult.targets],
      wslAvailable: wslResult.targets.length > 0,
      wslError: wslResult.error,
    };
  }
}

export const _test = {
  parseLastJson, parseChatOutput, assertSafeId, localOnlyEnv, isSensitiveEnvKey,
  processIsAlive, processIdentity, windowsIdentityStartedAfter, ownerIsAlive,
  readOwnerDocument, readOwnerFile,
  readGuardJournal, appendGuardRecord,
  hermesRootFromExecutable, runtimeTarget,
};
