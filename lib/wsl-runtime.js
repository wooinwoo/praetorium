import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { normalizeDeclaredPaths } from './candidate-snapshot.js';
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

  async candidateSnapshot({ distro, path, declaredPaths = [] }) {
    const name = assertDistro(distro);
    const root = normalizeWslPath(path);
    const normalizedDeclaredPaths = normalizeDeclaredPaths(declaredPaths, { caseSensitive: true });
    const script = [
      'set -euo pipefail',
      'root="$1"',
      'shift',
      'declared_count="$#"',
      'cd -- "$root"',
      'root_real="$(realpath -e -- .)"',
      'revision="$(git rev-parse HEAD 2>/dev/null || true)"',
      'max_bytes=$((512 * 1024 * 1024))',
      'deadline=$((SECONDS + 30))',
      'check_deadline() { test "$SECONDS" -le "$deadline" || { printf "candidate-deadline-exceeded" >&2; return 47; }; }',
      'is_protected_path() { local lower="${1,,}"; [[ "$lower" =~ (^|/)(\\.git|node_modules)(/|$) ]]; }',
      'is_declared_path() { local file="$1" declared; shift; is_protected_path "$file" && return 1; for declared in "$@"; do if test "$file" = "$declared" || [[ "$file" == "$declared/"* ]]; then return 0; fi; done; return 1; }',
      'assert_declared_literal() { local file="$1" expected resolved; is_protected_path "$file" && { printf "declared-excluded-path:%s" "$file" >&2; return 48; }; expected="$root_real/$file"; resolved="$(realpath -m -- "$file")" || { printf "declared-unresolved-path:%s" "$file" >&2; return 48; }; case "$resolved" in "$root_real"/*) ;; *) printf "declared-path-outside-root:%s" "$file" >&2; return 48;; esac; test "$resolved" = "$expected" || { printf "declared-symlink-candidate:%s" "$file" >&2; return 48; }; }',
      'declared_manifest() { local declared file name; for declared in "$@"; do check_deadline; assert_declared_literal "$declared"; printf "declared\\0%s\\0" "$declared"; if test -L "$declared"; then printf "declared-symlink-candidate:%s" "$declared" >&2; return 48; elif test -f "$declared"; then printf "file\\0"; elif test -d "$declared"; then printf "directory\\0"; while IFS= read -r -d "" file; do check_deadline; file="${file#./}"; name="${file##*/}"; name="${name,,}"; if test "$name" = ".git" || test "$name" = "node_modules"; then printf "entry\\0%s\\0excluded-directory\\0" "$file"; continue; fi; printf "entry\\0%s\\0" "$file"; if test -L "$file"; then printf "declared-symlink-candidate:%s" "$file" >&2; return 48; elif test -f "$file"; then printf "file\\0"; elif test -d "$file"; then printf "directory\\0"; else printf "declared-special-file:%s" "$file" >&2; return 48; fi; done < <(find "./$declared" -mindepth 1 \\( -iname .git -o -iname node_modules \\) -print0 -prune -o -print0 | sort -z); elif test -e "$declared"; then printf "declared-special-file:%s" "$declared" >&2; return 48; else printf "missing\\0"; fi; done; }',
      'declared_file_paths() { local declared; for declared in "$@"; do assert_declared_literal "$declared"; if test -f "$declared" || { ! test -e "$declared" && ! test -L "$declared"; }; then printf "%s\\0" "$declared"; elif test -d "$declared"; then find "./$declared" \\( -iname .git -o -iname node_modules \\) -prune -o \\( -type f -o -type l \\) -printf "%P\\0" | while IFS= read -r -d "" file; do printf "%s/%s\\0" "$declared" "$file"; done; else printf "declared-symlink-or-special:%s" "$declared" >&2; return 48; fi; done; }',
      'before_declared="$(declared_manifest "$@" | sha256sum | cut -d " " -f 1)"',
      'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  git_metadata() { { git rev-parse HEAD; git status --porcelain=v2 -z --untracked-files=all; git ls-files -s -z; git ls-files -co --exclude-standard -z; git submodule status --recursive 2>/dev/null || printf "submodule-status-unavailable"; } | sha256sum | cut -d " " -f 1; }',
      '  candidate_paths() { git ls-files -co --exclude-standard -z; declared_file_paths "$@"; }',
      '  before_metadata="$(git_metadata)"',
      '  if ! git status --porcelain=v2 --untracked-files=all | awk \'$1 ~ /^(1|2|u)$/ && $3 ~ /^S/ { if (substr($3,3,1) != "." || substr($3,4,1) != ".") exit 7 }\'; then printf "dirty-submodule-candidate" >&2; exit 46; fi',
      '  if test -n "$(git status --porcelain=v2 --untracked-files=all)"; then dirty=1; else dirty=0; fi',
      '  digest="$({',
      '    printf "praetorium-candidate-v1\\0"',
      '    git status --porcelain=v2 -z --untracked-files=all',
      '    git ls-files -s -z',
      '    git submodule status --recursive 2>/dev/null || printf "submodule-status-unavailable"',
      '    if test "$declared_count" -gt 0; then printf "declared-paths-v1\\0"; declared_manifest "$@"; fi',
      '    total=0; count=0',
      '    while IFS= read -r -d "" file; do',
      '      check_deadline',
      '      count=$((count + 1)); test "$count" -le 20000 || { printf "too-many-files" >&2; exit 42; }',
      '      printf "path\\0%s\\0" "$file"',
      '      declared=0; if is_declared_path "$file" "$@"; then declared=1; assert_declared_literal "$file"; fi',
      '      if test -L "$file"; then test "$declared" -eq 0 || { printf "declared-symlink-candidate:%s" "$file" >&2; exit 48; }; printf "symlink\\0"; readlink -- "$file"',
      '      elif test -f "$file"; then before="$(stat -c "%s:%y:%z:%i:%d" -- "$file")"; size="${before%%:*}"; total=$((total + size)); test "$total" -le "$max_bytes" || { printf "candidate-too-large" >&2; exit 43; }; printf "size\\0%s\\0" "$size"; sha256sum -- "$file" | cut -d " " -f 1; check_deadline; after="$(stat -c "%s:%y:%z:%i:%d" -- "$file")"; test "$before" = "$after" || { printf "candidate-changed" >&2; exit 44; }; test "$declared" -eq 0 || assert_declared_literal "$file"',
      '      elif test -e "$file"; then printf "not-file\\0"; else printf "missing\\0"; fi',
      '    done < <(candidate_paths "$@" | sort -zu)',
      '  } | sha256sum | cut -d " " -f 1)"',
      '  after_metadata="$(git_metadata)"',
      '  test "$before_metadata" = "$after_metadata" || { printf "candidate-metadata-changed" >&2; exit 45; }',
      'else',
      '  fallback_manifest() { find . \\( -iname .git -o -iname node_modules \\) -prune -o \\( -type f -o -type l \\) -print0 | sort -z | sha256sum | cut -d " " -f 1; }',
      '  candidate_paths() { find . \\( -iname .git -o -iname node_modules \\) -prune -o \\( -type f -o -type l \\) -printf "%P\\0"; declared_file_paths "$@"; }',
      '  before_metadata="$(fallback_manifest)"',
      '  dirty=1',
      '  digest="$({ printf "praetorium-candidate-v1\\0"; if test "$declared_count" -gt 0; then printf "declared-paths-v1\\0"; declared_manifest "$@"; fi; total=0; count=0; while IFS= read -r -d "" file; do check_deadline; count=$((count + 1)); test "$count" -le 20000 || exit 42; printf "path\\0%s\\0" "$file"; declared=0; if is_declared_path "$file" "$@"; then declared=1; assert_declared_literal "$file"; fi; if test -L "$file"; then test "$declared" -eq 0 || { printf "declared-symlink-candidate:%s" "$file" >&2; exit 48; }; printf "symlink\\0"; readlink -- "$file"; elif test -f "$file"; then before="$(stat -c "%s:%y:%z:%i:%d" -- "$file")"; size="${before%%:*}"; total=$((total + size)); test "$total" -le "$max_bytes" || exit 43; printf "size\\0%s\\0" "$size"; sha256sum -- "$file" | cut -d " " -f 1; check_deadline; after="$(stat -c "%s:%y:%z:%i:%d" -- "$file")"; test "$before" = "$after" || exit 44; test "$declared" -eq 0 || assert_declared_literal "$file"; else printf "missing\\0"; fi; done < <(candidate_paths "$@" | sort -zu); } | sha256sum | cut -d " " -f 1)"',
      '  after_metadata="$(fallback_manifest)"',
      '  test "$before_metadata" = "$after_metadata" || { printf "candidate-metadata-changed" >&2; exit 45; }',
      'fi',
      'after_declared="$(declared_manifest "$@" | sha256sum | cut -d " " -f 1)"',
      'test "$before_declared" = "$after_declared" || { printf "declared-candidate-changed" >&2; exit 49; }',
      'printf "%s\\nsha256:%s\\n%s\\n%s\\n" "$revision" "$digest" "$dirty" "$declared_count"',
    ].join('\n');
    const result = await this._run([
      '--distribution', name, '--exec', '/bin/bash', '-c', script, 'praetorium-snapshot', root,
      ...normalizedDeclaredPaths,
    ], { timeoutMs: 60000 });
    const [revision, digest, dirty, boundCount] = decode(result.stdout, 'utf8').split(/\r?\n/);
    if (!/^sha256:[a-f0-9]{64}$/i.test(digest || '')) throw new Error('WSL candidate snapshot returned an invalid digest.');
    if (Number(boundCount) !== normalizedDeclaredPaths.length) {
      throw new Error('WSL candidate snapshot did not bind every declared path.');
    }
    return {
      schema: 'candidate-snapshot.v1', revision: revision || null, digest,
      dirty: dirty === '1', fileCount: null,
      declaredPaths: normalizedDeclaredPaths,
      declaredPathCount: normalizedDeclaredPaths.length,
      declaredEntryCount: null,
      declaredFileCount: null,
      declaredBindings: normalizedDeclaredPaths.map(declaredPath => ({ path: declaredPath, state: 'bound' })),
      bindingMode: 'declared-paths.v1',
      observedAt: new Date().toISOString(),
    };
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
