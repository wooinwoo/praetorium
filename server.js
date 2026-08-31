import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLease, HermesRuntime } from './lib/hermes-runtime.js';
import { WslRuntime } from './lib/wsl-runtime.js';
import { DirectorService } from './lib/director-service.js';
import { WorkerTraceStream } from './lib/worker-trace-stream.js';
import { DATA_DIR, MAX_PROJECTS, PORT, PROJECTS_ROOT, addProject, deleteProject, getProjects, projectKey } from './lib/praetorium-config.js';
import { PROFILE_CATALOG } from './lib/workflow-catalog.js';
import { LOCAL_BIND_ADDRESS, isIgnoredBindRequest, isLoopbackAddress, isLoopbackHost } from './lib/local-only.js';
import { DirectorActivityStream, isLocalDirectorRequest, register as registerDirectors } from './routes/directors.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const MAX_BODY_BYTES = 1024 * 1024;
const routes = [];

function addRoute(method, pattern, handler) {
  const parameterNames = [];
  const expression = pattern.replace(/:(\w+)/g, (_match, name) => {
    parameterNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${expression}$`), parameterNames, handler });
}

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    const params = {};
    try {
      route.parameterNames.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    } catch {
      return { malformed: true };
    }
    return { handler: route.handler, params };
  }
  return null;
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function json(res, value, statusCode = 200) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, { ...securityHeaders('application/json; charset=utf-8'), 'Content-Length': body.length });
  res.end(body);
}

async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let length = 0;
  const limit = Math.max(1, Number(maxBytes) || MAX_BODY_BYTES);
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413, code: 'REQUEST_BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}

function sameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const source = req.headers.origin || req.headers.referer;
  if (!source) return isLoopbackAddress(req.socket.remoteAddress);
  try { return new URL(source).host === req.headers.host; }
  catch { return false; }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const directorState = join(DATA_DIR, 'directors.json');
const serverLease = acquireProcessLease({ leaseFile: `${directorState}.lease` });
const releaseServerLease = () => serverLease.release();
process.once('exit', releaseServerLease);
if (serverLease.recovered) {
  console.warn(`[Praetorium] Recovered stale server lease from PID ${serverLease.recovered.pid || 'unknown'}.`);
}

const wslRuntime = new WslRuntime();
const hermesRuntime = new HermesRuntime({ wslRuntime });
const directorService = new DirectorService({
  runtime: hermesRuntime,
  stateFile: directorState,
  projectsRoot: PROJECTS_ROOT,
  getProjects,
});
directorService.on('error', error => console.error('[Praetorium:Director]', error.message));
const directorActivityStream = new DirectorActivityStream({ source: directorService });
const workerTraceStream = new WorkerTraceStream({ service: directorService, runtime: hermesRuntime });
directorService.startScheduler(10000);

registerDirectors({ addRoute, json, readBody, directorService, activityStream: directorActivityStream });

addRoute('GET', '/api/directors/:id/tasks/:taskId/trace-stream', async (req, res) => {
  if (!isLocalDirectorRequest(req)) {
    return json(res, { error: 'Worker trace stream accepts same-origin loopback requests only.' }, 403);
  }
  try {
    await workerTraceStream.open(req, res, { directorId: req.params.id, taskId: req.params.taskId });
  } catch (error) {
    if (req.aborted || req.destroyed || res.destroyed || res.writableEnded) return;
    if (!res.headersSent) json(res, { error: error.message }, Number(error.statusCode) || 500);
    else res.end();
  }
});

addRoute('GET', '/api/health', (_req, res) => json(res, {
  status: 'ok',
  version: VERSION,
  pid: process.pid,
  localOnly: true,
  uptime: Math.round(process.uptime()),
  projects: getProjects().length,
  directors: directorService.listDirectors().length,
}));

addRoute('GET', '/api/projects', (_req, res) => json(res, getProjects()));

addRoute('GET', '/api/runtimes', async (req, res) => {
  try {
    const result = await hermesRuntime.describeTargets({ force: req.query.force === 'true' });
    result.profileTotal = PROFILE_CATALOG.length;
    await Promise.all(result.targets.filter(item => item.kind === 'wsl' && !item.system && !item.ready).map(async target => {
      if (target.wslVersion === 1) {
        target.setupLabel = 'Windows PowerShell';
        target.setupCommand = `wsl.exe --set-version "${target.distro}" 2`;
        return;
      }
      if (target.wslVersion !== 2) {
        target.setupLabel = 'Windows PowerShell';
        target.setupCommand = 'wsl.exe --update\nwsl.exe --list --verbose';
        return;
      }
      if (!target.home) return;
      if (target.codex?.compatible && target.codex?.appServer && !target.codex?.authenticated) {
        target.setupLabel = `${target.label} 터미널`;
        target.setupCommand = `${shellQuote(target.codex.path || 'codex')} login`;
        return;
      }
      try {
        const source = await wslRuntime.toWslPath(target.distro, ROOT);
        target.setupLabel = `${target.label} 터미널`;
        target.setupCommand = [
          `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v2026.8.19/scripts/install.sh | bash -s -- --branch v2026.8.19 --skip-setup --skip-browser --skip-computer-use --non-interactive`,
          `${shellQuote(`${target.home}/.hermes/node/bin/node`)} ${shellQuote(`${source}/scripts/bootstrap-wsl-runtime.mjs`)} --workdir ${shellQuote(`${target.home}/projects`)}`,
        ].join('\n');
      } catch { /* runtime diagnosis remains useful when wslpath is unavailable */ }
    }));
    json(res, result);
  }
  catch (error) { json(res, { error: error.message }, 500); }
});

addRoute('GET', '/api/profiles', (_req, res) => json(res, PROFILE_CATALOG));

addRoute('POST', '/api/system/shutdown', async (_req, res) => {
  const readiness = await directorService.beginShutdown();
  if (!readiness.safe) return json(res, readiness, 409);
  json(res, readiness, 202);
  setImmediate(() => {
    directorActivityStream.close();
    workerTraceStream.close();
    directorService.stopScheduler();
    server.close(() => {
      releaseServerLease();
      process.exit(0);
    });
  });
});

addRoute('POST', '/api/projects/validate', async (req, res) => {
  try {
    const body = await readBody(req);
    if (body.runtime !== 'wsl') {
      const path = resolve(String(body.path || ''));
      const info = await stat(path);
      return json(res, { valid: info.isDirectory(), exists: info.isDirectory(), path, runtime: 'windows' });
    }
    const validated = await wslRuntime.validateProject(body);
    if (!validated.valid) {
      return json(res, {
        ...validated,
        runtime: 'wsl',
        error: '선택한 WSL 배포판에 프로젝트 경로가 없습니다.',
      }, 400);
    }
    json(res, { ...validated, runtime: 'wsl' });
  } catch (error) { json(res, { valid: false, error: error.message }, 400); }
});

addRoute('POST', '/api/projects', async (req, res) => {
  try {
    const body = await readBody(req);
    if (body.runtime === 'wsl') {
      const validated = await wslRuntime.validateProject(body);
      if (!validated.valid) throw new Error('선택한 WSL 배포판에 프로젝트 경로가 없습니다.');
      body.path = validated.path;
      body.distro = validated.distro;
    }
    const project = addProject(body);
    directorService.syncProjects();
    json(res, project, 201);
  } catch (error) { json(res, { error: error.message }, 400); }
});

addRoute('DELETE', '/api/projects/:id', async (req, res) => {
  try {
    if (!await directorService.detachProject(req.params.id, deleteProject)) return json(res, { error: 'Project not found' }, 404);
    json(res, { deleted: true });
  } catch (error) { json(res, { error: error.message }, 409); }
});

addRoute('POST', '/api/projects/discover', async (req, res) => {
  try {
    const body = await readBody(req);
    const configured = getProjects();
    const runtime = body.runtime === 'wsl' ? 'wsl' : 'windows';
    const known = new Set(configured.map(projectKey));
    let added = 0;
    if (runtime === 'wsl') {
      const candidates = await wslRuntime.discoverProjects({ distro: body.distro, root: body.root });
      for (const candidate of candidates) {
        if (configured.length + added >= MAX_PROJECTS) break;
        const key = projectKey({ runtime: 'wsl', distro: body.distro, path: candidate });
        if (known.has(key)) continue;
        addProject({ name: candidate.split('/').at(-1), path: candidate, runtime: 'wsl', distro: body.distro });
        known.add(key);
        added += 1;
      }
    } else {
      const root = body.root ? resolve(String(body.root)) : PROJECTS_ROOT;
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (configured.length + added >= MAX_PROJECTS) break;
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const candidate = resolve(root, entry.name);
        const key = projectKey({ runtime: 'windows', path: candidate });
        if (known.has(key)) continue;
        try {
          await stat(join(candidate, '.git'));
          addProject({ name: entry.name, path: candidate, runtime: 'windows' });
          known.add(key);
          added += 1;
        } catch { /* not an immediate Git repository */ }
      }
    }
    directorService.syncProjects();
    json(res, { added, projects: getProjects() });
  } catch (error) { json(res, { error: error.message }, 400); }
});

const STATIC_ROOT = resolve(ROOT, 'dist');
const staticTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

async function serveStatic(pathname, res, method) {
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
  if (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/')) return false;
  const filePath = pathname === '/' ? resolve(STATIC_ROOT, 'index.html') : resolve(STATIC_ROOT, `.${pathname}`);
  if (filePath !== resolve(STATIC_ROOT, 'index.html') && !filePath.startsWith(`${STATIC_ROOT}${sep}`)) return false;
  let body;
  try { body = await readFile(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const contentType = staticTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
  res.writeHead(200, { ...securityHeaders(contentType), 'Content-Length': body.length });
  if (method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return json(res, { error: 'Praetorium accepts loopback requests only.' }, 403);
    }
    if (!sameOrigin(req)) return json(res, { error: 'Origin rejected.' }, 403);

    const url = new URL(req.url, `http://${req.headers.host}`);
    if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(url.pathname, res, req.method)) return;
    const route = findRoute(req.method, url.pathname);
    if (route?.malformed) return json(res, { error: 'Malformed URL parameter.' }, 400);
    if (!route) return json(res, { error: 'Not found' }, 404);
    req.params = route.params;
    req.query = Object.fromEntries(url.searchParams);
    await route.handler(req, res);
  } catch (error) {
    console.error('[Praetorium:HTTP]', error);
    if (!res.headersSent) json(res, { error: error.message || 'Internal server error' }, 500);
    else res.end();
  }
});

if (isIgnoredBindRequest(process.env.PRAETORIUM_BIND)) {
  console.warn('[Praetorium] Ignored non-loopback bind override.');
}

server.listen(PORT, LOCAL_BIND_ADDRESS, () => {
  console.log(`[Praetorium] v${VERSION} listening on http://${LOCAL_BIND_ADDRESS}:${PORT}`);
  console.log('[Praetorium] Remote access, gateways, webhooks, messaging, and shell terminals are disabled.');
});

server.once('error', error => {
  console.error('[Praetorium] Local server failed:', error.message);
  directorActivityStream.close();
  workerTraceStream.close();
  releaseServerLease();
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

function shutdown() {
  directorActivityStream.close();
  workerTraceStream.close();
  directorService.stopScheduler();
  server.close(() => {
    releaseServerLease();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export { server };
