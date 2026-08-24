import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { PROFILE_CATALOG } from './workflow-catalog.js';

export const PINNED_HERMES_VERSION = 'Hermes Agent v0.20.5';
export const PINNED_CODEX_VERSION = 'codex-cli 0.149.0';

const SAFE_DISTRO = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u;
const DEFAULT_TIMEOUT_MS = 15000;

function assertDistro(value) {
  const distro = String(value || '').trim();
  if (!SAFE_DISTRO.test(distro)) throw new Error('유효한 WSL 배포판을 선택하세요.');
  return distro;
}

export function normalizeWslPath(value) {
  const raw = String(value || '');
  if (raw !== raw.trim()) throw new Error('WSL 프로젝트 경로의 앞뒤 공백은 안전하게 구분할 수 없어 지원하지 않습니다.');
  if (!raw.startsWith('/') || /[\0\r\n]/.test(raw)) throw new Error('WSL 프로젝트는 /로 시작하는 Linux 절대 경로여야 합니다.');
  return posix.normalize(raw);
}

function decode(buffer, encoding = 'auto') {
  if (!buffer?.length) return '';
  if (encoding === 'utf16le' || (encoding === 'auto' && buffer.includes(0))) {
    return buffer.toString('utf16le').replace(/\0/g, '');
  }
  return buffer.toString('utf8');
}

function parseWslList(buffer) {
  return decode(buffer).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function capture(spawnImpl, command, args, { input = null, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(decode(result.stderr).trim() || `${command} exited with code ${code}`), { result }));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: 'WSL_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    if (input === null) child.stdin?.end();
    else child.stdin?.end(input);
  });
}

export class WslRuntime {
  constructor({ spawnImpl = spawn, wslBin = process.env.PRAETORIUM_WSL_BIN || 'wsl.exe', platform = process.platform } = {}) {
    this.spawnImpl = spawnImpl;
    this.wslBin = wslBin;
    this.platform = platform;
    this.cache = new Map();
  }

  async _run(args, options = {}) {
    if (this.platform !== 'win32') throw new Error('WSL 런타임은 Windows에서만 사용할 수 있습니다.');
    return capture(this.spawnImpl, this.wslBin, args, options);
  }

  async listDistributions() {
    if (this.platform !== 'win32') return [];
    try {
      const result = await this._run(['--list', '--quiet']);
      return parseWslList(result.stdout).map(name => ({
        name,
        system: /^docker-desktop(?:-data)?$/i.test(name),
      }));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async inspect(distro, { force = false } = {}) {
    const name = assertDistro(distro);
    const cached = this.cache.get(name);
    if (!force && cached && Date.now() - cached.checkedAt < 15000) return { ...cached };
    const status = {
      id: `wsl:${name}`,
      kind: 'wsl',
      distro: name,
      label: `WSL · ${name}`,
      ready: false,
      checkedAt: Date.now(),
      home: null,
      user: null,
      path: null,
      hermes: { installed: false, path: null, version: null, pinned: false },
      codex: { installed: false, path: null, version: null, pinned: false, authenticated: false },
      profiles: [],
      error: null,
    };
    try {
      const probe = await this._run([
        '--distribution', name, '--exec', '/bin/bash', '-lc',
        'printf "%s\\n" "$HOME" "$(id -un)" "$PATH" "$(command -v hermes || true)" "$(command -v codex || true)"',
      ]);
      const [home, user, path, hermesPath, codexPath] = decode(probe.stdout, 'utf8').split(/\r?\n/);
      status.home = home || null;
      status.user = user || null;
      status.path = path || null;
      status.hermes.path = hermesPath || null;
      status.codex.path = codexPath || null;

      const versionChecks = await Promise.allSettled([
        hermesPath ? this._run(['--distribution', name, '--exec', hermesPath, '--version']) : Promise.reject(new Error('Hermes not found')),
        codexPath ? this._run(['--distribution', name, '--exec', codexPath, '--version']) : Promise.reject(new Error('Codex not found')),
        codexPath ? this._run(['--distribution', name, '--exec', codexPath, 'login', 'status']) : Promise.reject(new Error('Codex not found')),
      ]);
      if (versionChecks[0].status === 'fulfilled') {
        status.hermes.version = decode(versionChecks[0].value.stdout, 'utf8').trim();
        status.hermes.installed = true;
        status.hermes.pinned = status.hermes.version.includes(PINNED_HERMES_VERSION);
      }
      if (versionChecks[1].status === 'fulfilled') {
        status.codex.version = decode(versionChecks[1].value.stdout, 'utf8').trim();
        status.codex.installed = true;
        status.codex.pinned = status.codex.version.includes(PINNED_CODEX_VERSION);
      }
      status.codex.authenticated = versionChecks[2].status === 'fulfilled';
      if (home) {
        try {
          const profiles = await this._run([
            '--distribution', name, '--exec', '/usr/bin/find', `${home}/.hermes/profiles`,
            '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-printf', '%f\\n',
          ]);
          status.profiles = decode(profiles.stdout, 'utf8').split(/\r?\n/).filter(Boolean).sort();
        } catch { /* an unbootstrapped runtime has no profile directory yet */ }
      }
      status.ready = status.hermes.pinned && status.codex.pinned && status.codex.authenticated
        && PROFILE_CATALOG.every(profile => status.profiles.includes(profile.id));
      if (!status.hermes.pinned || !status.codex.pinned) status.error = '고정된 Hermes와 Codex 런타임 준비가 필요합니다.';
      else if (!status.codex.authenticated) status.error = '이 WSL 배포판에서 Codex 로그인이 필요합니다.';
      else if (!status.ready) status.error = `Praetorium 역할 프로필이 ${status.profiles.length} / ${PROFILE_CATALOG.length}개 설치되어 있습니다.`;
    } catch (error) {
      status.error = error.message;
    }
    this.cache.set(name, status);
    return { ...status };
  }

  async listTargets({ force = false } = {}) {
    const distros = await this.listDistributions();
    return Promise.all(distros.map(async item => ({ ...(await this.inspect(item.name, { force })), system: item.system })));
  }

  async validateProject({ distro, path }) {
    const name = assertDistro(distro);
    const normalized = normalizeWslPath(path);
    try {
      await this._run(['--distribution', name, '--exec', '/usr/bin/test', '-d', normalized]);
    } catch (error) {
      if (error.result?.code === 1) return { valid: false, exists: false, git: false, path: normalized, distro: name };
      throw error;
    }
    let git = true;
    try { await this._run(['--distribution', name, '--exec', '/usr/bin/test', '-e', posix.join(normalized, '.git')]); }
    catch (error) {
      if (error.result?.code === 1) git = false;
      else throw error;
    }
    return { valid: true, exists: true, git, path: normalized, distro: name, name: posix.basename(normalized) };
  }

  async discoverProjects({ distro, root }) {
    const name = assertDistro(distro);
    const home = (await this.inspect(name)).home;
    const searchRoot = normalizeWslPath(root || `${home}/projects`);
    await this._run(['--distribution', name, '--exec', '/usr/bin/test', '-d', searchRoot]);
    const result = await this._run([
      '--distribution', name, '--exec', '/usr/bin/find', searchRoot,
      '-mindepth', '2', '-maxdepth', '3', '-name', '.git', '-print0',
    ], { timeoutMs: 30000 });
    const projects = decode(result.stdout, 'utf8').split('\0').filter(Boolean)
      .map(gitPath => posix.dirname(gitPath)).sort((a, b) => a.localeCompare(b));
    const projectSet = new Set(projects);
    return projects.filter(project => !projectSet.has(posix.dirname(project)));
  }

  async toWslPath(distro, windowsPath) {
    const name = assertDistro(distro);
    const result = await this._run(['--distribution', name, '--exec', '/usr/bin/wslpath', '-u', String(windowsPath)]);
    return decode(result.stdout, 'utf8').trim();
  }

  async launch({ distro, cwd, args, env = {}, board = null }) {
    const name = assertDistro(distro);
    const projectPath = normalizeWslPath(cwd);
    const target = await this.inspect(name);
    if (!target.ready) throw new Error(`${target.label} 런타임이 준비되지 않았습니다. 환경 관리에서 Hermes/Codex 상태를 확인하세요.`);
    const cleanEnv = {
      ...env,
      HOME: target.home,
      USER: target.user,
      LOGNAME: target.user,
      SHELL: '/bin/bash',
      PATH: target.path,
      LANG: 'C.UTF-8',
      HERMES_HOME: `${target.home}/.hermes`,
      ...(board ? { HERMES_KANBAN_DB: `${target.home}/.hermes/kanban/boards/${board}/kanban.db` } : {}),
    };
    const envArgs = Object.entries(cleanEnv).filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`);
    return {
      executable: this.wslBin,
      args: [
        '--distribution', name, '--cd', projectPath, '--exec', '/bin/bash', '-lc',
        'exec /usr/bin/env -i "$@"', 'praetorium', ...envArgs, target.hermes.path, ...args,
      ],
      cwd: undefined,
    };
  }
}

export const _test = { assertDistro, decode, parseWslList };
