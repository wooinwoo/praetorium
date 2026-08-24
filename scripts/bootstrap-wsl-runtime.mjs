#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_CATALOG } from '../lib/workflow-catalog.js';
import { patchHermesRuntime } from './patch-hermes-codex-runtime.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hermesRoot = process.env.HERMES_HOME || join(homedir(), '.hermes');
const profilesRoot = join(hermesRoot, 'profiles');
const sourceSkills = join(repoRoot, '.agents', 'skills');
const sourceReferences = join(repoRoot, '.agents', 'skill-references');
const sourceSouls = join(repoRoot, '.agents', 'hermes-profiles', 'souls');
const workdirIndex = process.argv.indexOf('--workdir');
const defaultWorkdir = resolve(workdirIndex >= 0 ? process.argv[workdirIndex + 1] : join(homedir(), 'projects'));
const pinnedCodexVersion = 'codex-cli 0.149.0';

function run(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options });
}

function parseLastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* skip Hermes preamble */ }
  }
  return [];
}

function writeLocalOnlyEnv(path) {
  const remote = /^\s*(?!#)(?:export\s+)?(?:API_SERVER_|WEBHOOK_|GATEWAY_|RELAY_|TELEGRAM_|DISCORD_|SLACK_|WHATSAPP_|MATRIX_|MATTERMOST_|SIGNAL_|IMESSAGE_|EMAIL_|QQ_|LINE_|DINGTALK_|WECOM_|MSTEAMS_|MS_TEAMS_)[A-Z0-9_]*\s*=/i;
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const clean = existing.filter(line => line && !remote.test(line));
  clean.push('API_SERVER_ENABLED=false', 'WEBHOOK_ENABLED=false', 'GATEWAY_ALLOW_ALL_USERS=false', 'WHATSAPP_ENABLED=false');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${clean.join('\n')}\n`, 'utf8');
}

function copyDirectoryChildren(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(destination, entry.name), { recursive: true, force: true });
  }
}

function nativeCodexCandidates() {
  const candidates = [
    join(hermesRoot, 'node', 'bin', 'codex'),
    join(homedir(), '.local', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot).sort().reverse()) candidates.push(join(nvmRoot, version, 'bin', 'codex'));
  }
  return candidates.filter(candidate => existsSync(candidate) && !candidate.startsWith('/mnt/'));
}

function codexVersion(node, entry) {
  try { return run(node, [realpathSync(entry), '--version'], { capture: true }).trim(); }
  catch { return ''; }
}

function ensureNativeCodex() {
  const destination = join(homedir(), '.local', 'bin', 'codex');
  const node = join(hermesRoot, 'node', 'bin', 'node');
  if (!existsSync(node)) throw new Error('Hermes-managed Linux Node runtime was not found.');
  let candidate = nativeCodexCandidates().find(entry => codexVersion(node, entry).includes(pinnedCodexVersion));
  if (!candidate) {
    const npm = join(hermesRoot, 'node', 'bin', 'npm');
    if (!existsSync(npm)) throw new Error('Hermes-managed npm was not found; cannot install the pinned WSL Codex CLI.');
    run(node, [realpathSync(npm), 'install', '--global', `@openai/codex@${pinnedCodexVersion.split(' ').at(-1)}`, '--prefix', join(homedir(), '.local')]);
    candidate = join(homedir(), '.local', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  }
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  writeFileSync(destination, `#!/bin/sh\nexec '${node.replaceAll("'", "'\\''")}' '${realpathSync(candidate).replaceAll("'", "'\\''")}' "$@"\n`, 'utf8');
  chmodSync(destination, 0o755);
  const installed = run(destination, ['--version'], { capture: true }).trim();
  if (!installed.includes(pinnedCodexVersion)) throw new Error(`Pinned WSL Codex verification failed: ${installed || 'not executable'}`);
  try { run(destination, ['login', 'status'], { capture: true }); }
  catch {
    process.stdout.write('Praetorium needs one Codex login inside this WSL distribution.\n');
    run(destination, ['login']);
    run(destination, ['login', 'status'], { capture: true });
  }
}

function installAssets(profile) {
  const profileRoot = join(profilesRoot, profile.id);
  copyDirectoryChildren(sourceSkills, join(profileRoot, 'skills'));
  copyDirectoryChildren(sourceReferences, join(profileRoot, 'skill-references'));
  const soulName = profile.group === 'director'
    ? (profile.id === 'skill-director' ? 'skill-director.SOUL.md' : 'project-director.SOUL.md')
    : profile.id === 'codex-implementer' ? 'implementer.SOUL.md'
      : profile.id === 'remediator' ? 'remediator.SOUL.md'
        : profile.id === 'quality-gate-reviewer' ? 'quality-gate.SOUL.md' : 'reviewer.SOUL.md';
  const board = profile.id.startsWith('project-director-') ? boards[Number(profile.id.at(-1)) - 1].slug : profile.id === 'skill-director' ? 'skill-governance' : 'none';
  const soul = readFileSync(join(sourceSouls, soulName), 'utf8')
    .replaceAll('{{PROFILE_NAME}}', profile.id)
    .replaceAll('{{BOARD_SLUG}}', board)
    .replaceAll('{{REVIEW_SKILL}}', profile.skill || 'specialist-review');
  writeFileSync(join(profileRoot, 'SOUL.md'), soul, 'utf8');
  writeLocalOnlyEnv(join(profileRoot, '.env'));
}

function profileSettings(profile) {
  return {
    'model.default': 'gpt-5.6-sol',
    'model.provider': 'openai-codex',
    'model.openai_runtime': 'codex_app_server',
    'agent.reasoning_effort': profile.reasoning,
    'approvals.single_query_mode': 'deny',
    'approvals.cron_mode': 'deny',
    'approvals.mode': 'off',
    'approvals.timeout': '300',
    'approvals.denial_breaker_threshold': '3',
    'security.allow_private_urls': 'false',
    'security.redact_secrets': 'true',
    'terminal.backend': 'local',
    'terminal.cwd': defaultWorkdir,
    'auxiliary.free_only': 'true',
    'kanban.dispatch_in_gateway': 'false',
    'kanban.review_dispatch': 'true',
    'kanban.auto_decompose': 'false',
    'kanban.max_in_progress': '12',
    'kanban.max_in_progress_per_profile': '1',
    'kanban.failure_limit': '2',
    'kanban.dispatch_stale_timeout_seconds': '14400',
    'kanban.reconcile_orphans': 'true',
  };
}

for (const required of [defaultWorkdir, sourceSkills, sourceReferences, sourceSouls]) {
  if (!existsSync(required)) throw new Error(`Required path not found: ${required}`);
}

const projects = readdirSync(defaultWorkdir, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(defaultWorkdir, entry.name, '.git'))).slice(0, 3);
const boards = Array.from({ length: 3 }, (_, index) => {
  const project = projects[index];
  return {
    slug: project ? basename(project.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `project-${index + 1}` : `project-${index + 1}`,
    name: project?.name || `Project ${index + 1}`,
    workdir: project ? join(defaultWorkdir, project.name) : defaultWorkdir,
  };
});
boards.push({ slug: 'skill-governance', name: 'Skill Governance', workdir: defaultWorkdir });

const patched = patchHermesRuntime(hermesRoot);
const hermes = patched.hermes;
ensureNativeCodex();
writeLocalOnlyEnv(join(hermesRoot, '.env'));
copyDirectoryChildren(sourceSkills, join(hermesRoot, 'skills'));
copyDirectoryChildren(sourceReferences, join(hermesRoot, 'skill-references'));

for (const profile of PROFILE_CATALOG) {
  const profileRoot = join(profilesRoot, profile.id);
  if (!existsSync(profileRoot)) {
    run(hermes, ['-p', 'default', 'profile', 'create', profile.id, '--clone', '--no-alias', '--description', profile.description]);
  }
  run(hermes, ['-p', 'default', 'profile', 'describe', profile.id, '--text', profile.description]);
  installAssets(profile);
  for (const [key, value] of Object.entries(profileSettings(profile))) {
    run(hermes, ['-p', profile.id, 'config', 'set', key, String(value)]);
  }
  if (profile.group === 'director') {
    run(hermes, ['-p', profile.id, 'config', 'set', 'kanban.orchestrator_profile', profile.id]);
    run(hermes, ['-p', profile.id, 'config', 'set', 'kanban.default_assignee', 'codex-implementer']);
  }
}

const python = [join(hermesRoot, 'hermes-agent', 'venv', 'bin', 'python'), join(hermesRoot, 'hermes-agent', 'bin', 'python')].find(existsSync);
if (!python) throw new Error('Hermes Python runtime not found.');
run(python, ['-c', 'from hermes_cli.config import load_config; from hermes_cli.codex_runtime_plugin_migration import migrate; report=migrate(load_config()); print(report.summary()); raise SystemExit(0 if report.written and not report.errors else 1)'], {
  cwd: join(hermesRoot, 'hermes-agent'), env: { ...process.env, HERMES_HOME: hermesRoot },
});

const listed = parseLastJson(run(hermes, ['-p', 'default', 'kanban', 'boards', 'list', '--json'], { capture: true }));
const existing = Array.isArray(listed) ? listed : listed.boards || [];
for (const board of boards) {
  if (!existing.some(item => (item.slug || item.id) === board.slug)) {
    run(hermes, ['-p', 'default', 'kanban', 'boards', 'create', board.slug, '--name', board.name, '--description', `Praetorium workstream for ${board.name}.`, '--default-workdir', board.workdir]);
  }
  run(hermes, ['-p', 'default', 'kanban', 'boards', 'set-default-workdir', board.slug, board.workdir]);
  run(hermes, ['-p', 'default', 'kanban', '--board', board.slug, 'init']);
}

process.stdout.write(`Praetorium WSL runtime ready: ${PROFILE_CATALOG.length} profiles, ${boards.length} boards, ${defaultWorkdir}\n`);
