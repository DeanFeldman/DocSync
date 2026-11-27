[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_. -]*$')][string]$Distribution = "Ubuntu",
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$Container
)

# An unconfigured container or stopped Docker daemon is an expected probe result.
# Windows PowerShell can turn redirected native stderr into a terminating error under Stop.
$ErrorActionPreference = "Continue"
$wsl = (Get-Command wsl.exe -ErrorAction SilentlyContinue).Source
if (-not $wsl) { exit 1 }
$docker = & $wsl -d $Distribution -u root -- sh -c 'if test -x /snap/bin/docker; then echo /snap/bin/docker; else command -v docker; fi' 2>$null
if ($LASTEXITCODE -ne 0 -or $docker -notin @("/snap/bin/docker", "/usr/bin/docker", "/usr/local/bin/docker")) {
    exit 1
}
# Docker may be stopped on the first launch after Windows restarts.
$null = & $wsl -d $Distribution -u root -- $docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0) {
    if ($docker -eq "/snap/bin/docker") {
        $null = & $wsl -d $Distribution -u root -- snap start docker 2>$null
    } else {
        $null = & $wsl -d $Distribution -u root -- systemctl start docker 2>$null
    }
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

$names = if ($Container) { @($Container) } else { @("docsync-onlyoffice", "docsync-onlyoffice-pilot") }
foreach ($name in $names) {
    $running = & $wsl -d $Distribution -u root -- $docker inspect --type container --format '{{.State.Running}}' $name 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    if ($running -ne "true") {
        $null = & $wsl -d $Distribution -u root -- $docker start $name 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
    }
    $mapping = & $wsl -d $Distribution -u root -- $docker port $name 80/tcp 2>$null
    if ($LASTEXITCODE -ne 0 -or @($mapping).Count -ne 1 -or $mapping -notmatch '^127\.0\.0\.1:(\d{4,5})$') {
        continue
    }
    $port = [int]$Matches[1]
    $secret = & $wsl -d $Distribution -u root -- $docker exec $name printenv JWT_SECRET 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$secret).Trim().Length -lt 24) { continue }

    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -like "*WSL*" -and $_.AddressState -eq "Preferred"
    } | Select-Object -ExpandProperty IPAddress -Unique)
    if ($addresses.Count -ne 1) { exit 1 }

    @{ origin = "http://127.0.0.1:$port"; relayHost = $addresses[0]; secret = ([string]$secret).Trim() } |
        ConvertTo-Json -Compress
    exit 0
}
exit 1
