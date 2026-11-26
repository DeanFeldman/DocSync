[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_. -]*$')][string]$Distribution = "Ubuntu",
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$Container = "docsync-onlyoffice",
    [ValidateRange(1024, 65535)][int]$Port = 8080,
    [switch]$UseExistingRelay
)

$ErrorActionPreference = "Stop"
$appDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$appExecutable = Join-Path $appDirectory "DocSync.exe"
$relayScript = Join-Path $PSScriptRoot "onlyoffice-wsl-relay.cjs"
if (-not (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
    throw "Run this script from the installed app's resources\onlyoffice folder."
}
$wsl = (Get-Command wsl.exe).Source
$dockerPath = & $wsl -d $Distribution -u root -- sh -c 'if test -x /snap/bin/docker; then echo /snap/bin/docker; else command -v docker; fi'
if ($LASTEXITCODE -ne 0 -or ($dockerPath -notin @("/snap/bin/docker", "/usr/bin/docker", "/usr/local/bin/docker"))) {
    throw "Install Docker Engine in the selected WSL distribution before starting DocSync."
}

$holder = $null
$relay = $null
$savedEnvironment = @{}
$environmentNames = @("DOCSYNC_ONLYOFFICE_URL", "DOCSYNC_ONLYOFFICE_SECRET", "DOCSYNC_ONLYOFFICE_WSL_RELAY_HOST", "ELECTRON_RUN_AS_NODE")
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
try {
    $holder = Start-Process -FilePath $wsl -ArgumentList "-d `"$Distribution`" -- sleep infinity" -WindowStyle Hidden -PassThru
    & $wsl -d $Distribution -u root -- $dockerPath start $Container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not start the configured ONLYOFFICE Docs container."
    }
    $secret = & $wsl -d $Distribution -u root -- $dockerPath exec $Container printenv JWT_SECRET
    if ($LASTEXITCODE -ne 0 -or ([string]$secret).Trim().Length -lt 24) {
        throw "Configure the ONLYOFFICE container with a JWT_SECRET of at least 24 characters."
    }
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -like "*WSL*" -and $_.AddressState -eq "Preferred"
    } | Select-Object -ExpandProperty IPAddress -Unique)
    if ($addresses.Count -ne 1) {
        throw "DocSync needs one active WSL NAT adapter with an IPv4 address."
    }
    $relayHost = $addresses[0]
    $origin = "http://127.0.0.1:$Port"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
    $healthy = $false
    do {
        try {
            $healthy = (Invoke-RestMethod -Uri "$origin/healthcheck" -TimeoutSec 2) -eq $true
        } catch {
            $healthy = $false
        }
        if (-not $healthy) { Start-Sleep -Milliseconds 750 }
    } while (-not $healthy -and [DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $healthy) {
        throw "ONLYOFFICE Docs did not become healthy at $origin. Check the container's port mapping."
    }

    if (-not $UseExistingRelay) {
        $env:ELECTRON_RUN_AS_NODE = "1"
        $relay = Start-Process -FilePath $appExecutable -ArgumentList ('"{0}" {1} 8092' -f $relayScript, $relayHost) -WindowStyle Hidden -PassThru
        $relayDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)
        $listening = $false
        do {
            Start-Sleep -Milliseconds 300
            $relay.Refresh()
            if ($relay.HasExited) {
                throw "The DocSync relay could not start. Check whether port 8092 is already in use on the WSL adapter."
            }
            $listening = $null -ne (Get-NetTCPConnection -LocalAddress $relayHost -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue |
                Where-Object OwningProcess -eq $relay.Id | Select-Object -First 1)
        } while (-not $listening -and [DateTimeOffset]::UtcNow -lt $relayDeadline)
        if (-not $listening) {
            throw "The DocSync relay did not begin listening on the WSL adapter."
        }
    }

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:DOCSYNC_ONLYOFFICE_URL = $origin
    $env:DOCSYNC_ONLYOFFICE_SECRET = ([string]$secret).Trim()
    $env:DOCSYNC_ONLYOFFICE_WSL_RELAY_HOST = $relayHost
    $desktop = Start-Process -FilePath $appExecutable -PassThru
    $desktop.WaitForExit()
    if ($desktop.ExitCode -ne 0) {
        throw "DocSync exited with code $($desktop.ExitCode)."
    }
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    foreach ($process in @($relay, $holder)) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -InputObject $process -ErrorAction SilentlyContinue
        }
    }
}
