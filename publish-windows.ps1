<#
.SYNOPSIS
    Build, smoke-test, and package TermFlow for Windows via Velopack (vpk),
    Authenticode-signed with Azure Trusted Signing.

.DESCRIPTION
    Modeled on rephlo-desktop/publish-windows.ps1, adapted for Tauri + a Rust
    Velopack library. Differences from the rephlo flow:

      * Build is `bun run build:tauri:pro` (not `dotnet publish`). That produces
        termflow.exe + the mcp/fabric/pty-host sidecars in src-tauri/target/release.
      * A clean payload is STAGED before packing — Tauri's target/release is full
        of cargo intermediates, so vpk must pack an allowlisted dir, not the whole
        target. The pty-host sidecar MUST be present (hot-swap depends on it).
      * A startup smoke test gates the pack: a build that crashes on launch never
        answers /health and is never shipped.
      * vpk is the PROJECT-LOCAL tool (.config/dotnet-tools.json), pinned to 1.2.0
        to match the `velopack` Rust crate (=1.2.0). A mismatched vpk produces an
        update feed the installed app's library cannot read. This does NOT use the
        machine's global vpk (other products pin different versions).
      * Azure Trusted Signing credentials (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET /
        AZURE_TENANT_ID) are pulled from Infisical at pack time, NOT a local
        signing\.env. The non-secret account metadata stays in signing\metadata.json.

.PARAMETER Version
    Semantic version (default 1.0.0). Must increase for auto-update to apply.

.PARAMETER Arch
    Target CPU: x64 (default) or arm64. arm64 cross-compiles to
    aarch64-pc-windows-msvc (needs the MSVC ARM64 build tools installed) and packs
    under the win-arm64 Velopack channel so its feed never collides with x64.

.PARAMETER Msi
    Also emit a machine-wide TermFlow-win.msi (elevated) alongside the per-user
    Setup.exe. Both are signed. Off by default (the no-admin Setup.exe is primary).

.PARAMETER InfisicalProjectId
    Infisical project id to read the Azure secrets from. Defaults to
    $env:INFISICAL_PROJECT_ID. Not needed if the repo has an .infisical.json
    (created by `infisical init`) — the CLI resolves the project from it.

.PARAMETER InfisicalEnv
    Infisical environment slug (default: $env:INFISICAL_ENV or "prod").

.PARAMETER InfisicalPath
    Infisical folder path holding the secrets (default "/").

.PARAMETER Unsigned
    Build + pack WITHOUT signing (skips Infisical + metadata). For local testing
    only — SmartScreen will warn on the produced installer.

.PARAMETER SkipSmoke
    Skip the startup smoke test. Not recommended.

.EXAMPLE
    infisical login          # once
    .\publish-windows.ps1 1.2.0 -InfisicalProjectId <id> -InfisicalEnv prod

.EXAMPLE
    .\publish-windows.ps1 1.2.0 -Unsigned      # local, unsigned
#>
param(
    [string]$Version            = "1.0.0",
    [string]$InfisicalProjectId = $env:INFISICAL_PROJECT_ID,
    [string]$InfisicalEnv       = $(if ($env:INFISICAL_ENV) { $env:INFISICAL_ENV } else { "dev" }),
    [string]$InfisicalPath      = $(if ($env:INFISICAL_PATH) { $env:INFISICAL_PATH } else { "/machine" }),
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [switch]$Msi,
    [switch]$Unsigned,
    [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

# vpk is a .NET tool; roll forward so a matching major runtime is enough.
$env:DOTNET_ROLL_FORWARD = "LatestMajor"

$ScriptDir   = $PSScriptRoot
# Arch mapping. x64 builds native to target\release. arm64 cross-compiles to
# target\aarch64-pc-windows-msvc\release — which requires BOTH the Rust target
# (`rustup target add aarch64-pc-windows-msvc`, already present) AND the MSVC
# ARM64 build tools (VS component Microsoft.VisualStudio.Component.VC.Tools.ARM64);
# without the ARM64 linker the cross-compile fails at link time. arm64 also packs
# under a distinct Velopack channel so its feed never collides with x64.
$ArchMap = @{
    x64   = @{ BuildScript = "build:tauri:pro";      RelSub = "src-tauri\target\release";                         Channel = $null;       HostArch = "AMD64" }
    arm64 = @{ BuildScript = "build:tauri:pro:arm64"; RelSub = "src-tauri\target\aarch64-pc-windows-msvc\release"; Channel = "win-arm64"; HostArch = "ARM64" }
}
$A = $ArchMap[$Arch]
$RelDir      = Join-Path $ScriptDir $A.RelSub
$StageDir    = Join-Path $ScriptDir "publish\win-$Arch"
$ReleasesDir = Join-Path $ScriptDir "releases"
$Metadata    = Join-Path $ScriptDir "signing\metadata.json"
$Icon        = Join-Path $ScriptDir "src-tauri\icons\icon.ico"
$PackId      = "TermFlow"
$PackTitle   = "TermFlow"
$MainExe     = "termflow.exe"

# Runtime payload — the ONLY things that belong next to the app in the package.
# The three sidecars are required; termflow-pty-host.exe in particular is what
# lets shells survive an update (design 003). Missing it = a broken hot-swap.
$PayloadFiles = @(
    "termflow.exe",
    "termflow-mcp-server.exe",
    "termflow-fabric.exe",
    "termflow-pty-host.exe"
)
# Resource dirs Tauri stages next to the exe (EULA/privacy/licences, etc.).
$PayloadDirs  = @("legal", "resources")

# Azure Trusted Signing credentials, resolved from Infisical. They live under
# AZURE_ARTIFACT_SIGNING_* names in Infisical (env 'dev', path '/machine'); map
# each to the env var vpk / the Azure SDK actually reads for Trusted Signing
# (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID). Note the secret name
# is AZURE_ARTIFACT_SIGNING_SECRET, not ..._CLIENT_SECRET.
$AzureSecretMap = [ordered]@{
    "AZURE_ARTIFACT_SIGNING_CLIENT_ID" = "AZURE_CLIENT_ID"
    "AZURE_ARTIFACT_SIGNING_SECRET"    = "AZURE_CLIENT_SECRET"
    "AZURE_ARTIFACT_SIGNING_TENANT_ID" = "AZURE_TENANT_ID"
}

Write-Host "=== TermFlow Windows Publish ($Arch) ===" -ForegroundColor Cyan
Write-Host "    Version : $Version"
Write-Host "    Output  : $ReleasesDir\"
Write-Host ""

# ─── Stage 1: Tauri release build (+ all sidecars) ────────────────────────────
Write-Host "=== Stage 1: bun run $($A.BuildScript) ===" -ForegroundColor Yellow
bun run $($A.BuildScript)
if ($LASTEXITCODE -ne 0) { Write-Error "$($A.BuildScript) failed ($LASTEXITCODE)"; exit $LASTEXITCODE }

# ─── Stage 2: startup smoke test (gate) ──────────────────────────────────────
# Only meaningful when the built binary can actually run on this host — an arm64
# binary won't launch on an x64 machine, so smoke is auto-skipped there.
$CanSmoke = ($env:PROCESSOR_ARCHITECTURE -eq $A.HostArch)
if ($SkipSmoke -or -not $CanSmoke) {
    $why = if (-not $CanSmoke) { " (can't run $Arch on $($env:PROCESSOR_ARCHITECTURE) host)" } else { " (-SkipSmoke)" }
    Write-Host "=== Stage 2: smoke test SKIPPED$why ===" -ForegroundColor DarkYellow
} else {
    Write-Host ""
    Write-Host "=== Stage 2: startup smoke test ===" -ForegroundColor Yellow
    bun scripts/smoke-test-release.mjs (Join-Path $RelDir "termflow.exe")
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Smoke test failed — the built app did not launch cleanly. Refusing to package."
        exit $LASTEXITCODE
    }
}

# ─── Stage 3: assemble a clean payload dir ───────────────────────────────────
Write-Host ""
Write-Host "=== Stage 3: stage payload -> $StageDir ===" -ForegroundColor Yellow
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

foreach ($f in $PayloadFiles) {
    $src = Join-Path $RelDir $f
    if (-not (Test-Path $src)) {
        Write-Error "Required payload file missing: $src. (Is the pty-host sidecar wired into tauri.pro.conf.json externalBin?)"
        exit 1
    }
    Copy-Item $src (Join-Path $StageDir $f) -Force
}
foreach ($d in $PayloadDirs) {
    $src = Join-Path $RelDir $d
    if (Test-Path $src) { Copy-Item $src (Join-Path $StageDir $d) -Recurse -Force }
}
Write-Host "    Staged $($PayloadFiles.Count) binaries + resource dirs"

# ─── Stage 4: resolve signing credentials from Infisical ─────────────────────
$SignArgs = @()
if ($Unsigned) {
    Write-Host ""
    Write-Host "=== Stage 4: UNSIGNED build (-Unsigned) ===" -ForegroundColor DarkYellow
    Write-Host "    SmartScreen will warn on the produced installer."
} else {
    Write-Host ""
    Write-Host "=== Stage 4: pull Azure Trusted Signing creds from Infisical ===" -ForegroundColor Yellow
    if (-not (Test-Path $Metadata)) {
        Write-Error "Missing $Metadata (Azure Trusted Signing account metadata). Create it (Endpoint/CodeSigningAccountName/CertificateProfileName) or pass -Unsigned."
        exit 1
    }
    if (-not (Get-Command infisical -ErrorAction SilentlyContinue)) {
        Write-Error "infisical CLI not found on PATH. Install it, run 'infisical login', or pass -Unsigned."
        exit 1
    }

    function Get-InfisicalSecret([string]$Name) {
        $iargs = @("secrets", "get", $Name, "--plain", "--silent", "--path", $InfisicalPath, "--env", $InfisicalEnv)
        if ($InfisicalProjectId) { $iargs += @("--projectId", $InfisicalProjectId) }
        $val = & infisical @iargs 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($val)) {
            throw "Infisical: could not read secret '$Name' (env='$InfisicalEnv', path='$InfisicalPath', projectId='$InfisicalProjectId'). Run 'infisical login', link the project (infisical init) or pass -InfisicalProjectId, or use -Unsigned."
        }
        return (($val | Select-Object -First 1)).Trim()
    }

    foreach ($src in $AzureSecretMap.Keys) {
        [System.Environment]::SetEnvironmentVariable($AzureSecretMap[$src], (Get-InfisicalSecret $src), "Process")
    }
    Write-Host "    Loaded AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID from Infisical (values not shown)"
    Write-Host "    Signing mode : Azure Trusted Signing"
    $SignArgs = @("--azureTrustedSignFile", $Metadata)
}

# ─── Stage 5: vpk pack (project-local vpk 1.2.0) ─────────────────────────────
# Always produces the per-user installer TermFlow-win-Setup.exe (manifest
# requestedExecutionLevel=asInvoker) — installs to %LOCALAPPDATA%\TermFlow with NO
# elevation / UAC, which is also what makes the per-user hot-swap work.
# -Msi additionally emits a machine-wide .msi bootstrap package. That MSI installs
# for all users and DOES require elevation (there is no per-user MSI in Velopack);
# it is opt-in so the no-admin Setup.exe stays the default. Both artifacts are
# signed by the same Azure Trusted Signing pass.
Write-Host ""
Write-Host "=== Stage 5: vpk pack$(if ($Msi) { ' (+ machine-wide MSI)' }) ===" -ForegroundColor Yellow
dotnet tool restore | Out-Null
New-Item -ItemType Directory -Force -Path $ReleasesDir | Out-Null

$MsiArgs     = if ($Msi) { @("--msi") } else { @() }
$ChannelArgs = if ($A.Channel) { @("--channel", $A.Channel) } else { @() }
$VpkArgs = @(
    "vpk", "pack",
    "--packId",      $PackId,
    "--packTitle",   $PackTitle,
    "--packVersion", $Version,
    "--packDir",     $StageDir,
    "--mainExe",     $MainExe,
    "--icon",        $Icon,
    "--outputDir",   $ReleasesDir
) + $ChannelArgs + $MsiArgs + $SignArgs

& dotnet @VpkArgs
if ($LASTEXITCODE -ne 0) { Write-Error "vpk pack failed ($LASTEXITCODE)"; exit $LASTEXITCODE }

# ─── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Green
Write-Host "Release artifacts in: $ReleasesDir\"
Get-ChildItem $ReleasesDir | Format-Table Name, @{L='Size';E={'{0:N1} MB' -f ($_.Length / 1MB)}}, LastWriteTime -AutoSize
Write-Host ""
Write-Host "Next: upload to the GitHub release feed the updater reads"
Write-Host "  (github.com/PMTLabs/termflow-core):  dotnet vpk upload github --repoUrl <url> --releaseName v$Version ..."
