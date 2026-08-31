[CmdletBinding()]
param(
    [string]$ProjectsRoot = 'C:\projects',
    [string]$Repository = 'wooinwoo/praetorium',
    [string]$Version = 'v2.3.0',
    [string]$SourceRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PraetoriumData\source'),
    [switch]$SkipAppInstall,
    [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HermesTag = 'v2026.8.19'
$HermesVersion = 'Hermes Agent v0.20.5'
$HermesInstallerUrl = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HermesTag/scripts/install.ps1"
$HermesInstallerSha256 = '74225BF244253BFA5BC2B1D16FA3BB8618E199A53D1C0344B37AB9930696D3BA'
$MinimumCodexVersion = [version]'0.149.0'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user, $env:Path) -join ';'
}

function Get-Application {
    param([Parameter(Mandatory)][string]$Name)
    Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Ensure-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$PackageId
    )
    if (Get-Application $Command) { return }
    if (-not (Get-Application 'winget.exe')) {
        throw "'$Command' is required and winget is unavailable. Install $PackageId, then rerun."
    }
    Write-Step "Installing $PackageId"
    & winget.exe install --id $PackageId -e --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $PackageId ($LASTEXITCODE)." }
    Refresh-ProcessPath
    if (-not (Get-Application $Command)) { throw "$PackageId installed, but '$Command' is still unavailable. Open a new PowerShell and rerun." }
}

function Get-HermesExecutable {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = @(
        (Join-Path $local 'hermes\hermes-agent\praetorium-venv\Scripts\hermes.exe'),
        (Join-Path $local 'hermes\hermes-agent\venv\Scripts\hermes.exe'),
        (Join-Path $local 'hermes\hermes-agent\bin\hermes.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Get-HermesVersion {
    param([Parameter(Mandatory)][string]$Executable)
    try {
        $output = (& $Executable --version 2>&1) -join [Environment]::NewLine
        if ($LASTEXITCODE -eq 0) { return $output }
    } catch { }
    return $null
}

function Get-TrustedPython {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = [Collections.Generic.List[string]]::new()
    $candidates.Add((Join-Path $local 'Programs\Python\Python312\python.exe'))
    $python = Get-Application 'python.exe'
    if ($python) { $candidates.Add($python.Source) }
    $launcher = Get-Application 'py.exe'
    if ($launcher) {
        try {
            $resolved = (& $launcher.Source -3.12 -c 'import sys; print(sys.executable)' 2>$null) -join ''
            if ($LASTEXITCODE -eq 0 -and $resolved.Trim()) { $candidates.Add($resolved.Trim()) }
        } catch { }
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $signature = Get-AuthenticodeSignature -LiteralPath $candidate
        if ($signature.Status -ne 'Valid') { continue }
        try {
            $version = (& $candidate -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>$null) -join ''
            if ($LASTEXITCODE -eq 0 -and [version]$version.Trim() -ge [version]'3.11.0' -and [version]$version.Trim() -lt [version]'3.14.0') {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        } catch { }
    }
    return $null
}

function Ensure-TrustedPython {
    $python = Get-TrustedPython
    if ($python) { return $python }
    if (-not (Get-Application 'winget.exe')) {
        throw 'A signed Python 3.11-3.13 runtime is required for Windows Smart App Control compatibility.'
    }
    Write-Step 'Installing signed Python 3.12 for Windows Smart App Control compatibility'
    & winget.exe install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install Python.Python.3.12 ($LASTEXITCODE)." }
    Refresh-ProcessPath
    $python = Get-TrustedPython
    if (-not $python) { throw 'Python 3.12 installed, but no valid Python Software Foundation signed runtime was found.' }
    return $python
}

function Install-PraetoriumHermesRuntime {
    param([Parameter(Mandatory)][string]$AgentRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $AgentRoot 'pyproject.toml') -PathType Leaf)) {
        throw "Pinned Hermes source is unavailable at '$AgentRoot'."
    }
    $python = Ensure-TrustedPython
    $venv = Join-Path $AgentRoot 'praetorium-venv'
    Write-Step 'Building Smart App Control compatible Hermes runtime from signed Python'
    & $python -m venv --clear $venv
    if ($LASTEXITCODE -ne 0) { throw "Signed Hermes virtual environment creation failed ($LASTEXITCODE)." }
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    $installTarget = $AgentRoot + '[mcp]'
    & $venvPython -m pip install --disable-pip-version-check --editable $installTarget
    if ($LASTEXITCODE -ne 0) { throw "Signed Hermes dependency install failed ($LASTEXITCODE)." }
    $mcpProbe = 'from mcp.server import MCPServer; import agent.transports.hermes_tools_mcp_server; print("PRAETORIUM_MCP_OK")'
    & $venvPython -c $mcpProbe
    if ($LASTEXITCODE -ne 0) {
        throw "Signed Hermes lifecycle MCP validation failed ($LASTEXITCODE)."
    }
    $hermes = Join-Path $venv 'Scripts\hermes.exe'
    $version = Get-HermesVersion -Executable $hermes
    if ($version -notmatch [regex]::Escape($HermesVersion)) {
        $versionDisplay = if ($version) { $version } else { 'no version output' }
        throw "Smart App Control compatible Hermes validation failed: $versionDisplay"
    }
    return $hermes
}

function Install-Hermes {
    $hermes = Get-HermesExecutable
    if ($hermes) {
        $current = Get-HermesVersion -Executable $hermes
        if ($current -match [regex]::Escape($HermesVersion)) {
            Write-Host "Hermes already pinned: $HermesVersion"
            return $hermes
        }
    }

    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $agentRoot = Join-Path $local 'hermes\hermes-agent'
    if (Test-Path -LiteralPath (Join-Path $agentRoot 'pyproject.toml') -PathType Leaf) {
        try {
            return Install-PraetoriumHermesRuntime -AgentRoot $agentRoot
        } catch {
            Write-Warning "Existing Hermes source could not be recovered with signed Python: $($_.Exception.Message)"
        }
    }

    Write-Step "Installing pinned Hermes $HermesTag (local CLI only)"
    $download = Join-Path ([IO.Path]::GetTempPath()) "praetorium-hermes-$HermesTag.ps1"
    Invoke-WebRequest -UseBasicParsing -Uri $HermesInstallerUrl -OutFile $download
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash
    if ($actualHash -ne $HermesInstallerSha256) {
        throw "Hermes installer checksum mismatch. Expected $HermesInstallerSha256, got $actualHash."
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $download -Tag $HermesTag -SkipSetup -SkipComputerUse -NonInteractive
    if ($LASTEXITCODE -ne 0) { throw "Hermes install failed ($LASTEXITCODE)." }
    $hermes = Get-HermesExecutable
    if (-not $hermes) { throw 'Hermes installed, but hermes.exe was not found.' }
    $installedVersion = Get-HermesVersion -Executable $hermes
    if ($installedVersion -notmatch [regex]::Escape($HermesVersion)) {
        $hermes = Install-PraetoriumHermesRuntime -AgentRoot $agentRoot
        $installedVersion = Get-HermesVersion -Executable $hermes
    }
    if ($installedVersion -notmatch [regex]::Escape($HermesVersion)) {
        $versionDisplay = if ($installedVersion) { $installedVersion } else { 'no version output' }
        throw "Unexpected Hermes version: $versionDisplay"
    }
    return $hermes
}

function Sync-Source {
    Write-Step "Syncing Praetorium source $Version"
    $parent = Split-Path -Parent $SourceRoot
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    if (Test-Path -LiteralPath (Join-Path $SourceRoot '.git') -PathType Container) {
        & git.exe -C $SourceRoot fetch origin --tags --prune
        if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }
        & git.exe -C $SourceRoot checkout --detach $Version
        if ($LASTEXITCODE -ne 0) { throw "git checkout $Version failed." }
    } elseif (Test-Path -LiteralPath $SourceRoot) {
        throw "SourceRoot exists but is not a Git repository: $SourceRoot"
    } else {
        & git.exe clone --branch $Version --depth 1 "https://github.com/$Repository.git" $SourceRoot
        if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
    }
}

function Get-CodexVersion {
    $application = Get-Application 'codex.exe'
    if (-not $application) { return $null }
    $versionOutput = (& $application.Source --version 2>&1) -join [Environment]::NewLine
    $match = [regex]::Match($versionOutput, '(?m)^[ \t]*codex-cli[ \t]+(\d+\.\d+\.\d+)[ \t]*\r?$')
    if (-not $match.Success) { return $null }
    return [version]$match.Groups[1].Value
}

function Test-CompatibleCodexVersion {
    param([AllowNull()][version]$Version)
    return $null -ne $Version -and $Version.Major -eq $MinimumCodexVersion.Major -and $Version -ge $MinimumCodexVersion
}

function Install-Codex {
    $installedVersion = Get-CodexVersion
    if (-not (Test-CompatibleCodexVersion $installedVersion)) {
        Write-Step $(if ($installedVersion) { "Updating Codex CLI $installedVersion to $MinimumCodexVersion" } else { "Installing Codex CLI $MinimumCodexVersion" })
        & npm.cmd install --global "@openai/codex@$MinimumCodexVersion"
        if ($LASTEXITCODE -ne 0) { throw "Codex CLI install failed ($LASTEXITCODE)." }
        Refresh-ProcessPath
        $installedVersion = Get-CodexVersion
    }
    if (-not (Test-CompatibleCodexVersion $installedVersion)) {
        $foundVersion = if ($installedVersion) { $installedVersion } else { 'unavailable' }
        throw "Codex CLI >=$MinimumCodexVersion <1.0.0 is required; found $foundVersion."
    }

    $application = Get-Application 'codex.exe'
    & $application.Source app-server --help *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Installed Codex CLI does not support app-server.' }

    & $application.Source login status
    if ($LASTEXITCODE -ne 0) {
        Write-Step 'One-time Codex account login (the only required interactive step)'
        & $application.Source login
        if ($LASTEXITCODE -ne 0) { throw 'Codex login did not complete.' }
    }
}

function Install-PraetoriumApp {
    Write-Step "Downloading checksummed GitHub release assets for $Version"
    $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Praetorium-Installer' }
    $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/tags/$Version"
    $installerAsset = $release.assets | Where-Object { $_.name -match '^Praetorium_.*_x64-setup\.exe$' } | Select-Object -First 1
    if (-not $installerAsset) { throw "Windows x64 installer not found in release $Version." }
    $checksumAsset = $release.assets | Where-Object { $_.name -eq "$($installerAsset.name).sha256" } | Select-Object -First 1
    if (-not $checksumAsset) { throw "Checksum asset missing for $($installerAsset.name)." }

    $downloadDir = Join-Path ([IO.Path]::GetTempPath()) "praetorium-$Version"
    [IO.Directory]::CreateDirectory($downloadDir) | Out-Null
    $installerPath = Join-Path $downloadDir $installerAsset.name
    $checksumPath = "$installerPath.sha256"
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $installerAsset.browser_download_url -OutFile $installerPath
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $checksumAsset.browser_download_url -OutFile $checksumPath
    $expected = ((Get-Content -Raw -LiteralPath $checksumPath).Trim() -split '\s+')[0].ToUpperInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash
    if ($actual -ne $expected) { throw "Praetorium installer checksum mismatch. Expected $expected, got $actual." }

    Write-Step 'Installing Praetorium for the current Windows user'
    $process = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Praetorium installer failed ($($process.ExitCode))." }
}

function Start-And-VerifyPraetorium {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = @(
        (Join-Path $local 'Praetorium\praetorium.exe'),
        (Join-Path $local 'Praetorium\Praetorium.exe')
    )
    $app = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $app) { throw 'Praetorium executable was not found after installation.' }
    Start-Process -FilePath $app

    $health = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3848/api/health' -TimeoutSec 2
            break
        } catch { }
    }
    $expectedVersion = $Version.TrimStart('v')
    if (-not $health -or $health.status -ne 'ok' -or $health.version -ne $expectedVersion) {
        throw "Praetorium did not report expected version $expectedVersion on loopback port 3848."
    }

    $listeners = @(Get-NetTCPConnection -LocalPort 3848 -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { throw 'Praetorium health passed, but no listening socket was found.' }
    $unsafe = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
    if ($unsafe.Count) { throw "Unsafe non-loopback listener detected: $($unsafe.LocalAddress -join ', ')" }
    if ($listeners.OwningProcess -notcontains [int]$health.pid) { throw 'Praetorium health PID does not own the loopback listener.' }
    Write-Host 'Verified: Praetorium listens only on loopback and reports healthy.' -ForegroundColor Green
}

if ($env:OS -ne 'Windows_NT') { throw 'This installer currently supports Windows only.' }

Write-Step 'Checking prerequisites'
Ensure-WingetPackage -Command 'git.exe' -PackageId 'Git.Git'
Ensure-WingetPackage -Command 'node.exe' -PackageId 'OpenJS.NodeJS.LTS'
Refresh-ProcessPath
if (-not (Get-Application 'npm.cmd')) { throw 'npm.cmd is required but unavailable.' }

[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($ProjectsRoot)) | Out-Null
$ProjectsRoot = [IO.Path]::GetFullPath($ProjectsRoot)
$env:PRAETORIUM_PROJECTS_ROOT = $ProjectsRoot
[Environment]::SetEnvironmentVariable('PRAETORIUM_PROJECTS_ROOT', $ProjectsRoot, 'User')

Install-Codex
$hermes = Install-Hermes
$env:HERMES_BIN = $hermes
[Environment]::SetEnvironmentVariable('HERMES_BIN', $hermes, 'User')
Sync-Source

Write-Step 'Installing Directors, workers, review skills, and local-only policy'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'scripts\bootstrap-director-system.ps1') -HermesExecutable $hermes -DefaultWorkdir $ProjectsRoot
if ($LASTEXITCODE -ne 0) { throw "Director bootstrap failed ($LASTEXITCODE)." }

if (-not $SkipAppInstall) { Install-PraetoriumApp }
if (-not $SkipLaunch -and -not $SkipAppInstall) { Start-And-VerifyPraetorium }

Write-Host "`nPraetorium $Version is ready." -ForegroundColor Green
Write-Host "Projects root: $ProjectsRoot"
Write-Host 'Network policy: local loopback only; no gateway, daemon, webhook, LAN, Tailscale, or messaging bridge was started.'
