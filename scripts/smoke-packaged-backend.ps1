[CmdletBinding()]
param(
    [string]$Executable = "apps/api/dist/docsync-api/docsync-api.exe",
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "docsync-packaged-smoke-" + [guid]::NewGuid().ToString("N")
)
$workspace = Join-Path $temporaryRoot "workspace"
$standardOutput = Join-Path $temporaryRoot "backend.stdout.log"
$standardError = Join-Path $temporaryRoot "backend.stderr.log"
$backendProcess = $null

$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$previousDataDirectory = $env:DOCUMENTSYNC_DATA_DIR
$previousPort = $env:DOCUMENTSYNC_PORT
$previousSessionToken = $env:DOCUMENTSYNC_SESSION_TOKEN

try {
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $env:DOCUMENTSYNC_DATA_DIR = $workspace
    $env:DOCUMENTSYNC_PORT = [string]$port
    $env:DOCUMENTSYNC_SESSION_TOKEN = ""

    $backendProcess = Start-Process `
        -FilePath $resolvedExecutable `
        -WorkingDirectory (Split-Path -Parent $resolvedExecutable) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $standardOutput `
        -RedirectStandardError $standardError `
        -PassThru

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $ready = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($backendProcess.HasExited) {
            throw "The packaged backend exited early with code $($backendProcess.ExitCode)."
        }
        try {
            $health = Invoke-RestMethod `
                -Uri "http://127.0.0.1:$port/api/health" `
                -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $ready) {
        throw "The packaged backend did not reach /api/health within $TimeoutSeconds seconds."
    }
    Write-Host "Packaged backend smoke test passed: $resolvedExecutable"
}
catch {
    if (Test-Path -LiteralPath $standardError) {
        Write-Host "Recent packaged backend stderr:"
        Get-Content -LiteralPath $standardError -Tail 80
    }
    if (Test-Path -LiteralPath $standardOutput) {
        Write-Host "Recent packaged backend stdout:"
        Get-Content -LiteralPath $standardOutput -Tail 80
    }
    throw
}
finally {
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
        $backendProcess.WaitForExit(5000) | Out-Null
    }

    if ($null -eq $previousDataDirectory) {
        Remove-Item Env:DOCUMENTSYNC_DATA_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:DOCUMENTSYNC_DATA_DIR = $previousDataDirectory
    }
    if ($null -eq $previousPort) {
        Remove-Item Env:DOCUMENTSYNC_PORT -ErrorAction SilentlyContinue
    }
    else {
        $env:DOCUMENTSYNC_PORT = $previousPort
    }
    if ($null -eq $previousSessionToken) {
        Remove-Item Env:DOCUMENTSYNC_SESSION_TOKEN -ErrorAction SilentlyContinue
    }
    else {
        $env:DOCUMENTSYNC_SESSION_TOKEN = $previousSessionToken
    }

    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $resolvedSystemTemp = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetTempPath()
    )
    if (
        $resolvedTemporaryRoot.StartsWith(
            $resolvedSystemTemp,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        (Split-Path -Leaf $resolvedTemporaryRoot) -like "docsync-packaged-smoke-*"
    ) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
