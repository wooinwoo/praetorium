[CmdletBinding()]
param(
    [string]$HermesRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'hermes')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-PraetoriumLf {
    param([string]$Value)
    return $Value.Replace("`r`n", "`n")
}

function Set-PraetoriumPatchedFiles {
    param(
        [System.Collections.IDictionary]$Files,
        [scriptblock]$ReplaceFile = {
            param($Temporary, $Path, $Backup)
            [IO.File]::Replace($Temporary, $Path, $Backup, $true)
        },
        [scriptblock]$RestoreFile = {
            param($Backup, $Path)
            [IO.File]::Copy($Backup, $Path, $true)
        }
    )

    $encoding = [Text.UTF8Encoding]::new($false)
    $prepared = [Collections.Generic.List[object]]::new()
    try {
        foreach ($entry in $Files.GetEnumerator()) {
            $path = [string]$entry.Key
            $nextSource = [string]$entry.Value
            if ([IO.File]::ReadAllText($path) -ceq $nextSource) {
                continue
            }
            $suffix = "$PID.$([Guid]::NewGuid().ToString('N'))"
            $temporary = "$path.praetorium-$suffix.tmp"
            $backup = "$path.praetorium-$suffix.bak"
            $item = [pscustomobject]@{
                Path = $path
                Temporary = $temporary
                Backup = $backup
                Committed = $false
                PreserveBackup = $false
            }
            $prepared.Add($item)
            [IO.File]::WriteAllText($temporary, $nextSource, $encoding)
        }
        foreach ($item in $prepared) {
            & $ReplaceFile $item.Temporary $item.Path $item.Backup
            $item.Committed = $true
        }
    } catch {
        $cause = $_
        $rollbackFailures = [Collections.Generic.List[string]]::new()
        for ($index = $prepared.Count - 1; $index -ge 0; $index--) {
            $item = $prepared[$index]
            if (-not $item.Committed) {
                continue
            }
            try {
                & $RestoreFile $item.Backup $item.Path
            } catch {
                $item.PreserveBackup = $true
                $rollbackFailures.Add("$($item.Path): $($_.Exception.Message)")
            }
        }
        $rollback = if ($rollbackFailures.Count) {
            "Rollback failed for $($rollbackFailures -join '; ')"
        } else {
            'Applied files were rolled back.'
        }
        throw "Hermes patch commit failed. $rollback Cause: $($cause.Exception.Message)"
    } finally {
        foreach ($item in $prepared) {
            $artifacts = @($item.Temporary)
            if (-not $item.PreserveBackup) {
                $artifacts += $item.Backup
            }
            foreach ($artifact in $artifacts) {
                if (Test-Path -LiteralPath $artifact) {
                    Remove-Item -LiteralPath $artifact -Force
                }
            }
        }
    }
    return $prepared.Count
}

$HermesRoot = [IO.Path]::GetFullPath($HermesRoot)
$runtimeProvider = Join-Path $HermesRoot 'hermes-agent\hermes_cli\runtime_provider.py'
$appServerClient = Join-Path $HermesRoot 'hermes-agent\agent\transports\codex_app_server.py'
$codexRuntime = Join-Path $HermesRoot 'hermes-agent\agent\codex_runtime.py'
$codexPluginMigration = Join-Path $HermesRoot 'hermes-agent\hermes_cli\codex_runtime_plugin_migration.py'
$kanbanDb = Join-Path $HermesRoot 'hermes-agent\hermes_cli\kanban_db.py'
$kanbanTools = Join-Path $HermesRoot 'hermes-agent\tools\kanban_tools.py'
$hermesExeCandidates = @(
    (Join-Path $HermesRoot 'hermes-agent\praetorium-venv\Scripts\hermes.exe'),
    (Join-Path $HermesRoot 'hermes-agent\venv\Scripts\hermes.exe'),
    (Join-Path $HermesRoot 'hermes-agent\bin\hermes.exe')
)
$hermesExe = $hermesExeCandidates | Where-Object {
    Test-Path -LiteralPath $_ -PathType Leaf
} | Select-Object -First 1

if (-not $hermesExe) {
    throw "Hermes executable not found under '$HermesRoot'."
}
if (-not (Test-Path -LiteralPath $runtimeProvider -PathType Leaf)) {
    throw "Hermes runtime provider not found: $runtimeProvider"
}
if (-not (Test-Path -LiteralPath $appServerClient -PathType Leaf)) {
    throw "Hermes Codex app-server client not found: $appServerClient"
}
if (-not (Test-Path -LiteralPath $codexRuntime -PathType Leaf)) {
    throw "Hermes Codex runtime not found: $codexRuntime"
}
if (-not (Test-Path -LiteralPath $codexPluginMigration -PathType Leaf)) {
    throw "Hermes Codex plugin migration not found: $codexPluginMigration"
}
if (-not (Test-Path -LiteralPath $kanbanDb -PathType Leaf)) {
    throw "Hermes Kanban runtime not found: $kanbanDb"
}
if (-not (Test-Path -LiteralPath $kanbanTools -PathType Leaf)) {
    throw "Hermes Kanban tools not found: $kanbanTools"
}

$version = (& $hermesExe --version 2>&1) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0 -or $version -notmatch 'Hermes Agent v0\.20\.5\b') {
    throw "Praetorium's Codex runtime bridge is pinned to Hermes Agent v0.20.5; got: $version"
}

$marker = 'PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1'
$source = [IO.File]::ReadAllText($runtimeProvider)
if (-not $source.Contains($marker)) {
    $needle = '    requested_provider = resolve_requested_provider(requested)'
    $matches = ([regex]::Matches($source, [regex]::Escape($needle))).Count
    if ($matches -ne 1) {
        throw "Hermes source layout changed: expected exactly one runtime-provider insertion point, found $matches."
    }

# Hermes v0.20.5 resolves an openai-codex OAuth token before applying its
# codex_app_server transport override. That token is never used by the selected
# transport: `codex app-server` authenticates through the Codex CLI's own local
# login. This narrowly-scoped bridge returns a virtual runtime only when the
# profile explicitly opted into codex_app_server. The marker never enters the
# child environment or a network request; if Codex is logged out, app-server
# itself fails closed with its normal authentication error.
$bridge = @'


    # PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1
    # `codex app-server` owns authentication through the local Codex CLI. Avoid
    # requiring a redundant Hermes OAuth token before that stdio child starts.
    _praetorium_model_cfg = _get_model_config()
    if (
        requested_provider in {"openai", "openai-codex"}
        and str(_praetorium_model_cfg.get("openai_runtime") or "").strip().lower()
        == "codex_app_server"
    ):
        return {
            "provider": "openai-codex",
            "api_mode": "codex_app_server",
            "base_url": DEFAULT_CODEX_BASE_URL,
            "api_key": "praetorium-local-codex-app-server",
            "source": "codex-cli-local-auth",
            "requested_provider": requested_provider,
        }
'@

    $patched = $source.Replace($needle, $needle + $bridge)
    $source = $patched
    Write-Host 'Prepared Hermes Codex app-server authentication bridge.'
} else {
    Write-Host 'Hermes Codex app-server authentication bridge is already installed.'
}

# The upstream v0.20.5 app-server client adds the Kanban DB writable root only
# for dispatched workers. A semantic Director also writes the active board,
# but has HERMES_KANBAN_BOARD rather than HERMES_KANBAN_TASK. Expand that one
# guard and keep the same upstream workspace-write + network-off overrides.
$boardMarker = 'PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1'
$appServerSource = [IO.File]::ReadAllText($appServerClient)
if (-not $appServerSource.Contains($boardMarker)) {
    $appServerNeedle = '        if spawn_env.get("HERMES_KANBAN_TASK"):'
    $appServerMatches = ([regex]::Matches($appServerSource, [regex]::Escape($appServerNeedle))).Count
    if ($appServerMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one app-server Kanban guard, found $appServerMatches."
    }
    $appServerReplacement = @'
        # PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1
        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):
'@
    $appServerPatched = $appServerSource.Replace($appServerNeedle, $appServerReplacement.TrimEnd())
    $appServerSource = $appServerPatched
    Write-Host 'Prepared Hermes Director board-root sandbox bridge.'
} else {
    Write-Host 'Hermes Director board-root sandbox bridge is already installed.'
}

# Codex parses `-c` values as TOML. Raw Windows backslashes make the writable
# roots array fall back to a string value, which app-server rejects during
# initialize. Forward slashes are valid native Windows paths and valid TOML.
$windowsPathMarker = 'PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1'
if (-not $appServerSource.Contains($windowsPathMarker)) {
    $pathNeedle = '            app_server_args.extend('
    $pathMatches = ([regex]::Matches($appServerSource, [regex]::Escape($pathNeedle))).Count
    if ($pathMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one app-server argument insertion point, found $pathMatches."
    }
    $pathReplacement = @'
            # PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1
            kanban_root = str(kanban_root).replace("\\", "/")
            app_server_args.extend(
'@
    $pathPatched = $appServerSource.Replace($pathNeedle, $pathReplacement.TrimEnd())
    $appServerSource = $pathPatched
    Write-Host 'Prepared Hermes Windows writable-root TOML bridge.'
} else {
    Write-Host 'Hermes Windows writable-root TOML bridge is already installed.'
}

# Directors and specialist reviewers must be structurally read-only. The
# Director returns a validated action envelope; Praetorium itself writes tasks
# to the board after validation. Reviewers return reports but never mutate the
# candidate they inspect.
$readOnlyMarker = 'PRAETORIUM_READ_ONLY_ROLE_BRIDGE_V1'
if (-not $appServerSource.Contains($readOnlyMarker)) {
    $argsNeedle = '        app_server_args = list(extra_args or [])'
    $guardNeedle = '        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):'
    if (([regex]::Matches($appServerSource, [regex]::Escape($argsNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: app-server args insertion point is not unique.'
    }
    if (([regex]::Matches($appServerSource, [regex]::Escape($guardNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: Director board guard is not unique.'
    }
    $argsReplacement = @'
        app_server_args = list(extra_args or [])
        # PRAETORIUM_READ_ONLY_ROLE_BRIDGE_V1
        _praetorium_read_only = (
            spawn_env.get("PRAETORIUM_DIRECTOR_MODE") == "true"
            or spawn_env.get("PRAETORIUM_REVIEWER_MODE") == "true"
        )
        if _praetorium_read_only:
            app_server_args.extend(["-c", 'sandbox_mode="read-only"'])
'@
    $guardReplacement = '        if not _praetorium_read_only and (spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD")):'
    $appServerPatched = $appServerSource.Replace($argsNeedle, $argsReplacement.TrimEnd()).Replace($guardNeedle, $guardReplacement)
    $appServerSource = $appServerPatched
    Write-Host 'Prepared structural read-only Director/reviewer bridge.'
} else {
    Write-Host 'Hermes structural read-only Director/reviewer bridge is already installed.'
}

# Hermes profiles have a static terminal.cwd fallback. A project Director is
# selected dynamically by Praetorium, so that static value must not decide the
# Codex app-server thread root. The parent supplies this absolute path in the
# child environment; this pinned bridge gives it precedence without enabling
# any broader sandbox or network permission.
$projectCwdMarker = 'PRAETORIUM_PROJECT_CWD_BRIDGE_V1'
$codexRuntimeSource = [IO.File]::ReadAllText($codexRuntime)
if (-not $codexRuntimeSource.Contains($projectCwdMarker)) {
    $cwdNeedle = '        cwd = getattr(agent, "session_cwd", None) or str(resolve_agent_cwd())'
    $cwdMatches = ([regex]::Matches($codexRuntimeSource, [regex]::Escape($cwdNeedle))).Count
    if ($cwdMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one Codex runtime cwd assignment, found $cwdMatches."
    }
    $cwdReplacement = @'
        # PRAETORIUM_PROJECT_CWD_BRIDGE_V1
        import os as _praetorium_os

        cwd = (
            _praetorium_os.environ.get("PRAETORIUM_PROJECT_CWD")
            or getattr(agent, "session_cwd", None)
            or str(resolve_agent_cwd())
        )
'@
    $codexRuntimePatched = $codexRuntimeSource.Replace($cwdNeedle, $cwdReplacement.TrimEnd())
    $codexRuntimeSource = $codexRuntimePatched
    Write-Host 'Prepared Hermes project-scoped Codex cwd bridge.'
} else {
    Write-Host 'Hermes project-scoped Codex cwd bridge is already installed.'
}

# Codex app-server workers do not receive Hermes' in-process lifecycle tools.
# Make the required completion/block handoff explicit in every worker turn and
# mark specialist reviewer profiles for the read-only bridge above.
$workerLifecycleMarker = 'PRAETORIUM_WORKER_LIFECYCLE_BRIDGE_V1'
$kanbanSource = [IO.File]::ReadAllText($kanbanDb)
if (-not $kanbanSource.Contains($workerLifecycleMarker)) {
    $profileNeedle = '    profile_arg = normalize_profile_name(task.assignee)'
    $promptNeedle = '    prompt = f"work kanban task {task.id}"'
    if (([regex]::Matches($kanbanSource, [regex]::Escape($profileNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: worker profile insertion point is not unique.'
    }
    if (([regex]::Matches($kanbanSource, [regex]::Escape($promptNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: worker prompt insertion point is not unique.'
    }
    $profileReplacement = @'
    profile_arg = normalize_profile_name(task.assignee)

    # PRAETORIUM_WORKER_LIFECYCLE_BRIDGE_V1
'@
    $promptReplacement = @'
    prompt = (
        f"Work Kanban task {task.id}. Read the full card before acting. "
        "You must finish the durable board lifecycle before your final answer: "
        "call the kanban_complete tool with evidence and artifacts on success, "
        "or kanban_block with the concrete blocker. Plain text is not completion."
    )
'@
    $kanbanPatched = $kanbanSource.Replace($profileNeedle, $profileReplacement.TrimEnd()).Replace($promptNeedle, $promptReplacement.TrimEnd())
    $reviewerEnvNeedle = '    env["HERMES_KANBAN_TASK"] = task.id'
    $reviewerEnvReplacement = @'
    if profile_arg.endswith("-reviewer"):
        env["PRAETORIUM_REVIEWER_MODE"] = "true"
    env["HERMES_KANBAN_TASK"] = task.id
'@
    if (([regex]::Matches($kanbanPatched, [regex]::Escape($reviewerEnvNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: worker environment insertion point is not unique.'
    }
    $kanbanPatched = $kanbanPatched.Replace($reviewerEnvNeedle, $reviewerEnvReplacement.TrimEnd())
    $kanbanSource = $kanbanPatched
    Write-Host 'Prepared durable worker lifecycle and read-only reviewer bridge.'
} else {
    Write-Host 'Hermes durable worker lifecycle bridge is already installed.'
}

# Mark dispatched workers so their existing Codex app-server thread emits a
# complete, public operational transcript to the task log.
$workerConsoleEnvMarker = 'PRAETORIUM_CODEX_WORKER_CONSOLE_ENV_V1'
if (-not $kanbanSource.Contains($workerConsoleEnvMarker)) {
    $envNeedle = '    env["HERMES_KANBAN_TASK"] = task.id'
    if (([regex]::Matches($kanbanSource, [regex]::Escape($envNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: Worker console environment insertion point is not unique.'
    }
    $envReplacement = @'
    # PRAETORIUM_CODEX_WORKER_CONSOLE_ENV_V1
    env["PRAETORIUM_WORKER_CONSOLE"] = "true"
    env["HERMES_KANBAN_TASK"] = task.id
'@
    $kanbanPatched = $kanbanSource.Replace($envNeedle, $envReplacement.TrimEnd())
    $kanbanSource = $kanbanPatched
    Write-Host 'Prepared Codex Worker console environment bridge.'
} else {
    Write-Host 'Codex Worker console environment bridge is already installed.'
}

# Put the complete bounded card directly into Codex's first user turn. Asking
# a worker to rediscover its task through tools wastes time and can violate a
# task-specific command allowlist before the card is even loaded.
$workerContextMarker = 'PRAETORIUM_WORKER_CONTEXT_PROMPT_V2'
if (-not $kanbanSource.Contains($workerContextMarker)) {
    $kanbanSource = ConvertTo-PraetoriumLf $kanbanSource
    $contextNeedle = @'
    prompt = (
        f"Work Kanban task {task.id}. Read the full card before acting. "
        "You must finish the durable board lifecycle before your final answer: "
        "call the kanban_complete tool with evidence and artifacts on success, "
        "or kanban_block with the concrete blocker. Plain text is not completion."
    )
'@
    $contextNeedleText = ConvertTo-PraetoriumLf ($contextNeedle.TrimEnd())
    if (([regex]::Matches($kanbanSource, [regex]::Escape($contextNeedleText))).Count -ne 1) {
        throw 'Hermes source layout changed: authoritative Worker context insertion point is not unique.'
    }
    $contextReplacement = @'
    # PRAETORIUM_WORKER_CONTEXT_PROMPT_V2
    # Put the authoritative card directly into Codex's first user message.
    # Making the model rediscover its own task through tools caused needless
    # board exploration and could violate a narrow command allowlist.
    try:
        with connect_closing(board=board) as _praetorium_context_conn:
            _praetorium_worker_context = build_worker_context(
                _praetorium_context_conn, task.id
            )
    except Exception as _praetorium_context_error:
        _log.warning(
            "kanban worker: full context render failed for %s: %s",
            task.id, _praetorium_context_error,
        )
        _praetorium_worker_context = (
            f"# Kanban task {task.id}: {task.title}\n\n"
            f"## Body\n{task.body or '(no body)'}"
        )
    prompt = (
        f"{_praetorium_worker_context}\n\n"
        "## Execution contract\n"
        "The card above is the complete authoritative Director instruction. "
        "Do not inspect the board database or search for the card; it is already included. "
        "Respect every command, read, write, and delegation restriction literally. "
        "Publish the requested public checkpoints as task comments. "
        # PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3
        "Use the native kanban_complete or kanban_block tool; never invoke "
        "hermes kanban through the shell. "
        "Finish the durable board lifecycle before your final answer: call the "
        "kanban_complete tool with evidence and artifacts on success, or "
        "kanban_block with the concrete blocker. Plain text is not completion."
    )
'@
    $contextReplacementText = ConvertTo-PraetoriumLf ($contextReplacement.TrimEnd())
    $kanbanPatched = $kanbanSource.Replace($contextNeedleText, $contextReplacementText)
    $kanbanSource = $kanbanPatched
    Write-Host 'Prepared authoritative full-card Worker prompt bridge.'
} else {
    Write-Host 'Authoritative full-card Worker prompt bridge is already installed.'
}

$codexPluginMigrationSource = ConvertTo-PraetoriumLf ([IO.File]::ReadAllText($codexPluginMigration))
$lifecycleEnvMarker = 'PRAETORIUM_CODEX_MCP_LIFECYCLE_ENV_V1'
if (-not $codexPluginMigrationSource.Contains($lifecycleEnvMarker)) {
    $lifecycleEnvNeedle = @'
    if env:
        out["env"] = env
    # Generous timeouts
'@
    $lifecycleEnvReplacement = @'
    if env:
        out["env"] = env
    # PRAETORIUM_CODEX_MCP_LIFECYCLE_ENV_V1
    # Codex intentionally forwards only explicitly allowlisted parent variables
    # into stdio MCP children. Kanban tools are registered from this per-run
    # context, so omitting it makes a successful Worker unable to comment,
    # complete, block, or heartbeat its durable task.
    out["env_vars"] = [
        "HERMES_HOME",
        "HERMES_KANBAN_TASK",
        "HERMES_KANBAN_DB",
        "HERMES_KANBAN_BOARD",
        "HERMES_KANBAN_WORKSPACES_ROOT",
        "HERMES_KANBAN_WORKSPACE",
        "HERMES_KANBAN_RUN_ID",
        "HERMES_KANBAN_CLAIM_LOCK",
        "HERMES_PROFILE",
        "PRAETORIUM_PROJECT_CWD",
        "PRAETORIUM_WORKER_CONSOLE",
    ]
    out["required"] = True
    # Generous timeouts
'@
    $lifecycleEnvNeedleText = ConvertTo-PraetoriumLf ($lifecycleEnvNeedle.TrimEnd())
    $lifecycleEnvReplacementText = ConvertTo-PraetoriumLf ($lifecycleEnvReplacement.TrimEnd())
    if (([regex]::Matches($codexPluginMigrationSource, [regex]::Escape($lifecycleEnvNeedleText))).Count -ne 1) {
        throw 'Hermes source layout changed: Codex MCP lifecycle environment insertion point is not unique.'
    }
    $codexPluginMigrationSource = $codexPluginMigrationSource.Replace($lifecycleEnvNeedleText, $lifecycleEnvReplacementText)
    Write-Host 'Prepared Codex MCP lifecycle environment forwarding.'
} else {
    Write-Host 'Codex MCP lifecycle environment forwarding is already installed.'
}

# A materialized Worker must execute its assigned action itself. Owner goals can
# contain Director-facing delegation language, which otherwise tempts the Codex
# Worker to impersonate the Director and create an invisible child hierarchy.
$workerRoleBoundaryMarker = 'PRAETORIUM_WORKER_ROLE_BOUNDARY_V1'
if (-not $kanbanSource.Contains($workerRoleBoundaryMarker)) {
    $kanbanSource = ConvertTo-PraetoriumLf $kanbanSource
    $roleBoundaryNeedle = '        f"{_praetorium_worker_context}\n\n"'
    if (([regex]::Matches($kanbanSource, [regex]::Escape($roleBoundaryNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: Worker role boundary insertion point is not unique.'
    }
    $roleBoundaryReplacement = @'
        # PRAETORIUM_WORKER_ROLE_BOUNDARY_V1
        f"{_praetorium_worker_context}\n\n"
        "## Worker identity\n"
        f"You are the already-created assigned Worker running profile {profile_arg}. "
        "Owner-objective language about creating, assigning, managing, or monitoring Workers is Director context only. "
        "Execute only the card's assigned [ACTION] yourself. Do not impersonate the Director. "
        "Never spawn, delegate to, or manage subagents, child Workers, or additional sessions; "
        "the Praetorium Director exclusively owns the visible Worker graph. "
'@
    $roleBoundaryReplacementText = ConvertTo-PraetoriumLf ($roleBoundaryReplacement.TrimEnd())
    $kanbanSource = $kanbanSource.Replace($roleBoundaryNeedle, $roleBoundaryReplacementText)
    Write-Host 'Prepared explicit Worker identity and delegation boundary.'
} else {
    Write-Host 'Explicit Worker identity and delegation boundary is already installed.'
}

# The lifecycle is a structured Worker tool call, not a shell command. Keeping
# it out of PowerShell avoids quoting failures and duplicate terminal retries.
$nativeLifecycleMarker = 'PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3'
if (-not $kanbanSource.Contains($nativeLifecycleMarker)) {
    $kanbanSource = ConvertTo-PraetoriumLf $kanbanSource
    $lifecycleNeedle = @'
        "Publish the requested public checkpoints as task comments. "
        "Finish the durable board lifecycle before your final answer: call the "
'@
    $lifecycleNeedleText = ConvertTo-PraetoriumLf ($lifecycleNeedle.TrimEnd())
    if (([regex]::Matches($kanbanSource, [regex]::Escape($lifecycleNeedleText))).Count -ne 1) {
        throw 'Hermes source layout changed: native lifecycle instruction insertion point is not unique.'
    }
    $lifecycleReplacement = @'
        "Publish the requested public checkpoints as task comments. "
        # PRAETORIUM_WORKER_NATIVE_LIFECYCLE_V3
        "Use the native kanban_complete or kanban_block tool; never invoke "
        "hermes kanban through the shell. "
        "Finish the durable board lifecycle before your final answer: call the "
'@
    $lifecycleReplacementText = ConvertTo-PraetoriumLf ($lifecycleReplacement.TrimEnd())
    $kanbanPatched = $kanbanSource.Replace($lifecycleNeedleText, $lifecycleReplacementText)
    $kanbanSource = $kanbanPatched
    Write-Host 'Prepared native Worker lifecycle tool instruction.'
} else {
    Write-Host 'Native Worker lifecycle tool instruction is already installed.'
}

# Deliver live comments to the active Codex turn itself. Hermes' generic
# steer queue only drains between its own tool iterations; Codex app-server
# owns that loop and therefore requires its native turn/steer operation.
$nativeSteerMarker = 'PRAETORIUM_CODEX_NATIVE_STEER_BRIDGE_V1'
$kanbanToolsSource = [IO.File]::ReadAllText($kanbanTools)
if (-not $kanbanToolsSource.Contains($nativeSteerMarker)) {
    $steerNeedle = '        return bool(agent.steer(note))'
    if (([regex]::Matches($kanbanToolsSource, [regex]::Escape($steerNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: native Codex steer insertion point is not unique.'
    }
    $steerReplacement = @'
        # PRAETORIUM_CODEX_NATIVE_STEER_BRIDGE_V1
        # A Codex app-server turn owns its internal tool loop. Deliver live
        # operator guidance through turn/steer instead of Hermes' next-tool
        # result queue, while preserving the legacy path for other runtimes.
        if getattr(agent, "api_mode", None) == "codex_app_server":
            redirect = getattr(agent, "redirect", None)
            accepted = bool(redirect(note)) if callable(redirect) else False
        else:
            accepted = bool(agent.steer(note))
        # PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2
        if accepted and os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true":
            print(f"\n\033[96m[DIRECTOR -> WORKER]\033[0m\n{note}\n", flush=True)
        return accepted
'@
    $kanbanToolsPatched = $kanbanToolsSource.Replace($steerNeedle, $steerReplacement.TrimEnd())
    $kanbanToolsSource = $kanbanToolsPatched
    Write-Host 'Prepared native Codex Worker turn/steer bridge.'
} else {
    Write-Host 'Native Codex Worker turn/steer bridge is already installed.'
}

# Repair the one display label if an older Windows PowerShell invocation read
# the UTF-8 patch source through its legacy code page.
$nativeSteerAsciiMarker = 'PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2'
if (-not $kanbanToolsSource.Contains($nativeSteerAsciiMarker)) {
    $nativeSteerPattern = '        if accepted and os\.environ\.get\("PRAETORIUM_WORKER_CONSOLE"\) == "true":\r?\n            print\(f"[^\r\n]*\r?\n'
    $nativeSteerMatches = [regex]::Matches($kanbanToolsSource, $nativeSteerPattern)
    if ($nativeSteerMatches.Count -ne 1) {
        throw "Hermes source layout changed: native steer console repair count is $($nativeSteerMatches.Count)."
    }
    $nativeSteerAscii = @'
        # PRAETORIUM_CODEX_NATIVE_STEER_ASCII_V2
        if accepted and os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true":
            print(f"\n\033[96m[DIRECTOR -> WORKER]\033[0m\n{note}\n", flush=True)
'@
    $kanbanToolsPatched = [regex]::Replace($kanbanToolsSource, $nativeSteerPattern, $nativeSteerAscii.TrimEnd() + [Environment]::NewLine, 1)
    $kanbanToolsSource = $kanbanToolsPatched
    Write-Host 'Prepared native Codex Worker steer console-label repair.'
} else {
    Write-Host 'Native Codex Worker steer console label is ASCII-safe.'
}

# Mirror the real Codex app-server event stream into the Worker task log.
# Raw hidden reasoning text stays private; readable reasoning summaries,
# plans, commands, command output, file changes, tools, and answers are shown.
$traceMarker = 'PRAETORIUM_CODEX_WORKER_TRACE_BRIDGE_V1'
if (-not $codexRuntimeSource.Contains($traceMarker)) {
    $codexRuntimeSource = ConvertTo-PraetoriumLf $codexRuntimeSource
    $traceStateNeedle = '    started: dict[str, tuple[str, dict, float]] = {}'
    $traceDispatchNeedle = @'
        if not isinstance(params, dict):
            params = {}
'@
    $traceDispatchNeedleText = ConvertTo-PraetoriumLf ($traceDispatchNeedle.TrimEnd())
    if (([regex]::Matches($codexRuntimeSource, [regex]::Escape($traceStateNeedle))).Count -ne 1) {
        throw 'Hermes source layout changed: Codex trace state insertion point is not unique.'
    }
    if (([regex]::Matches($codexRuntimeSource, [regex]::Escape($traceDispatchNeedleText))).Count -ne 1) {
        throw 'Hermes source layout changed: Codex trace dispatch insertion point is not unique.'
    }
    $traceStateReplacement = @'
    started: dict[str, tuple[str, dict, float]] = {}

    # PRAETORIUM_CODEX_WORKER_TRACE_BRIDGE_V1
    # The Kanban process already owns a real Codex app-server thread. Mirror
    # its public operational event stream to stdout so the per-task log is the
    # same session transcript an interactive Codex client would render.
    import os as _praetorium_os
    _praetorium_trace_enabled = (
        _praetorium_os.environ.get("PRAETORIUM_WORKER_CONSOLE") == "true"
    )
    _praetorium_streamed_items: set[str] = set()
    _praetorium_open_sections: set[str] = set()

    def _praetorium_console(text: Any = "", *, end: str = "\n") -> None:
        if not _praetorium_trace_enabled:
            return
        print(str(text), end=end, flush=True)

    def _praetorium_item_text(item: dict) -> str:
        parts = []
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") in {
                "text", "input_text", "output_text"
            }:
                value = content.get("text") or ""
                if value:
                    parts.append(str(value))
        return "\n".join(parts)

    def _praetorium_trace_event(method: str, params: dict) -> None:
        if not _praetorium_trace_enabled:
            return
        if method == "turn/started":
            turn = params.get("turn") or {}
            _praetorium_console(
                f"\n\033[90m-- Codex turn {str(turn.get('id') or '')[:12]} --\033[0m"
            )
            return
        if method == "turn/completed":
            turn = params.get("turn") or {}
            _praetorium_console(
                f"\n\033[90m-- turn {turn.get('status') or 'completed'} --\033[0m"
            )
            return
        if method == "turn/plan/updated":
            _praetorium_console("\n\033[94mPLAN\033[0m")
            for entry in params.get("plan") or []:
                if not isinstance(entry, dict):
                    continue
                state = entry.get("status") or "pending"
                mark = "[x]" if state in {"completed", "complete"} else "[>]" if state in {"inProgress", "in_progress"} else "[ ]"
                _praetorium_console(f"  {mark} {entry.get('step') or ''}")
            return
        if method == "item/reasoning/summaryTextDelta":
            key = f"reasoning:{params.get('itemId') or ''}"
            if key not in _praetorium_open_sections:
                _praetorium_open_sections.add(key)
                _praetorium_console("\n\033[95mREASONING SUMMARY\033[0m")
            _praetorium_console(params.get("delta") or "", end="")
            return
        if method == "item/reasoning/textDelta":
            # Raw hidden reasoning is deliberately not exposed. Codex's
            # readable summary stream above is the public reasoning surface.
            return
        if method == "item/agentMessage/delta":
            item_id = str(params.get("itemId") or "")
            key = f"agent:{item_id}"
            if key not in _praetorium_open_sections:
                _praetorium_open_sections.add(key)
                _praetorium_console("\n\033[92mCodex\033[0m")
            _praetorium_streamed_items.add(item_id)
            _praetorium_console(params.get("delta") or params.get("text") or "", end="")
            return
        if method == "item/commandExecution/outputDelta":
            _praetorium_console(params.get("delta") or "", end="")
            return
        if method in {"warning", "error", "configWarning"}:
            error = params.get("error") or {}
            message = params.get("message") or params.get("summary") or error.get("message") or "Codex runtime warning"
            _praetorium_console(f"\n\033[91m! {message}\033[0m")
            return

        item = params.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type") or ""
        item_id = str(item.get("id") or "")
        if method == "item/started" and item_type == "userMessage":
            text = _praetorium_item_text(item)
            if text:
                _praetorium_console(f"\n\033[96mDirector -> Worker\033[0m\n{text}")
        elif method == "item/started" and item_type == "commandExecution":
            command = item.get("command") or ""
            if isinstance(command, list):
                command = " ".join(str(part) for part in command)
            cwd = item.get("cwd") or ""
            _praetorium_console(f"\n\033[93m$ {command}\033[0m")
            if cwd:
                _praetorium_console(f"\033[90m  cwd: {cwd}\033[0m")
        elif method == "item/completed" and item_type == "commandExecution":
            code = item.get("exitCode")
            duration = item.get("durationMs")
            suffix = f" / {duration}ms" if duration is not None else ""
            _praetorium_console(f"\n\033[90m[exit {code if code is not None else '?'}{suffix}]\033[0m")
        elif method in {"item/started", "item/completed"} and item_type == "fileChange":
            verb = "editing" if method == "item/started" else "files changed"
            paths = [str(change.get("path") or "") for change in item.get("changes") or [] if isinstance(change, dict)]
            _praetorium_console(f"\n\033[94m{verb}: {', '.join(path for path in paths if path) or 'file change'}\033[0m")
        elif method == "item/started" and item_type in {"mcpToolCall", "dynamicToolCall", "webSearch", "collabToolCall", "imageView"}:
            name = item.get("tool") or item.get("query") or item_type
            server = item.get("server")
            label = f"{server}/{name}" if server else name
            _praetorium_console(f"\n\033[94m> {label}\033[0m")
        elif method == "item/completed" and item_type == "agentMessage" and item_id not in _praetorium_streamed_items:
            text = item.get("text") or ""
            if text:
                _praetorium_console(f"\n\033[92mCodex\033[0m\n{text}")
        elif method == "item/completed" and item_type == "contextCompaction":
            _praetorium_console("\n\033[90m[context compacted]\033[0m")
'@
    $traceDispatchReplacement = @'
        if not isinstance(params, dict):
            params = {}
        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)
'@
    $traceStateReplacementText = ConvertTo-PraetoriumLf ($traceStateReplacement.TrimEnd())
    $traceDispatchReplacementText = ConvertTo-PraetoriumLf ($traceDispatchReplacement.TrimEnd())
    $codexRuntimePatched = $codexRuntimeSource.Replace($traceStateNeedle, $traceStateReplacementText).Replace($traceDispatchNeedleText, $traceDispatchReplacementText)
    $codexRuntimeSource = $codexRuntimePatched
    Write-Host 'Prepared full Codex Worker event trace bridge.'
} else {
    Write-Host 'Full Codex Worker event trace bridge is already installed.'
}

# Hermes activity callbacks can remain idle while app-server owns a long Codex
# turn. Poll durable task comments from the actual notification stream so a
# live Owner/Director instruction reaches turn/steer even during that loop.
$eventSteerMarker = 'PRAETORIUM_CODEX_EVENT_STEER_POLL_V1'
if (-not $codexRuntimeSource.Contains($eventSteerMarker)) {
    $codexRuntimeSource = ConvertTo-PraetoriumLf $codexRuntimeSource
    $eventSteerNeedle = @'
        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)
'@
    $eventSteerNeedleText = ConvertTo-PraetoriumLf ($eventSteerNeedle.TrimEnd())
    if (([regex]::Matches($codexRuntimeSource, [regex]::Escape($eventSteerNeedleText))).Count -ne 1) {
        throw 'Hermes source layout changed: Codex event steer insertion point is not unique.'
    }
    $eventSteerReplacement = @'
        try:
            _praetorium_trace_event(method, params)
        except Exception:
            logger.debug("Praetorium Codex trace bridge raised", exc_info=True)
        # PRAETORIUM_CODEX_EVENT_STEER_POLL_V1
        # App-server owns the long-running inner loop, so normal Hermes
        # activity callbacks may not fire while a turn is busy. Poll the
        # durable comment bridge from the Codex notification stream itself.
        if _praetorium_trace_enabled:
            try:
                from tools.kanban_tools import inject_new_comments_from_env
                inject_new_comments_from_env(agent)
            except Exception:
                logger.debug("Praetorium Codex steer poll raised", exc_info=True)
'@
    $eventSteerReplacementText = ConvertTo-PraetoriumLf ($eventSteerReplacement.TrimEnd())
    $codexRuntimePatched = $codexRuntimeSource.Replace($eventSteerNeedleText, $eventSteerReplacementText)
    $codexRuntimeSource = $codexRuntimePatched
    Write-Host 'Prepared event-driven Codex Worker turn/steer polling.'
} else {
    Write-Host 'Event-driven Codex Worker turn/steer polling is already installed.'
}

$stagedFiles = [ordered]@{}
$stagedFiles[$runtimeProvider] = $source
$stagedFiles[$appServerClient] = $appServerSource
$stagedFiles[$codexRuntime] = $codexRuntimeSource
$stagedFiles[$codexPluginMigration] = $codexPluginMigrationSource
$stagedFiles[$kanbanDb] = $kanbanSource
$stagedFiles[$kanbanTools] = $kanbanToolsSource
$changedFileCount = Set-PraetoriumPatchedFiles -Files $stagedFiles
Write-Host "Praetorium Hermes bridge ready; committed $changedFileCount changed source file(s)."
