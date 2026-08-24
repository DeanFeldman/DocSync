param(
    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 500)]
    [int]$MaxRenders = 25
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$word = $null
$document = $null
$renderCount = 0
$wordProcessId = 0
$wordProcessStartTimeUtcTicks = 0

function Send-WorkerMessage {
    param([hashtable]$Message)
    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Start-WordApplication {
    $startedAt = [System.Diagnostics.Stopwatch]::StartNew()
    $existingWordProcessIds = @(
        Get-Process -Name WINWORD -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Id }
    )
    $script:word = New-Object -ComObject Word.Application
    $script:word.Visible = $false
    $script:word.DisplayAlerts = 0
    $script:word.AutomationSecurity = 3
    $script:word.Options.UpdateLinksAtOpen = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $ownedProcess = Get-Process -Name WINWORD -ErrorAction SilentlyContinue |
            Where-Object { $existingWordProcessIds -notcontains $_.Id } |
            Sort-Object StartTime -Descending |
            Select-Object -First 1
        if ($null -ne $ownedProcess) {
            $script:wordProcessId = $ownedProcess.Id
            $script:wordProcessStartTimeUtcTicks = (
                $ownedProcess.StartTime.ToUniversalTime().Ticks
            )
            break
        }
        Start-Sleep -Milliseconds 100
    }
    $startedAt.Stop()
    return $startedAt.Elapsed.TotalMilliseconds
}

function Stop-WordApplication {
    $ownedWordProcessId = $script:wordProcessId
    $ownedWordStartTimeUtcTicks = $script:wordProcessStartTimeUtcTicks
    if ($null -ne $script:document) {
        try { $script:document.Close(0) } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:document) } catch {}
        $script:document = $null
    }
    if ($null -ne $script:word) {
        try { $script:word.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:word) } catch {}
        $script:word = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($ownedWordProcessId -gt 0) {
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            $ownedProcess = Get-Process -Id $ownedWordProcessId -ErrorAction SilentlyContinue
            if (
                $null -eq $ownedProcess -or
                $ownedProcess.StartTime.ToUniversalTime().Ticks -ne $ownedWordStartTimeUtcTicks
            ) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        $ownedProcess = Get-Process -Id $ownedWordProcessId -ErrorAction SilentlyContinue
        if (
            $null -ne $ownedProcess -and
            $ownedProcess.StartTime.ToUniversalTime().Ticks -eq $ownedWordStartTimeUtcTicks
        ) {
            Stop-Process -Id $ownedWordProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    $script:wordProcessId = 0
    $script:wordProcessStartTimeUtcTicks = 0
}

$workerStartedAt = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $wordStartupMs = Start-WordApplication
    $workerStartedAt.Stop()
    Send-WorkerMessage @{
        type = "ready"
        ok = $true
        word_startup_ms = [Math]::Round($wordStartupMs, 2)
        worker_startup_ms = [Math]::Round($workerStartedAt.Elapsed.TotalMilliseconds, 2)
    }

    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $line | ConvertFrom-Json
        $jobId = [string]$request.job_id
        if ([string]$request.action -eq "shutdown") {
            Stop-WordApplication
            Send-WorkerMessage @{ type = "shutdown"; ok = $true; job_id = $jobId }
            break
        }
        if ([string]$request.action -ne "render") {
            Send-WorkerMessage @{
                type = "result"
                ok = $false
                job_id = $jobId
                category = "invalid_request"
                error = "The worker request was invalid."
                worker_unusable = $false
            }
            continue
        }

        $total = [System.Diagnostics.Stopwatch]::StartNew()
        $wordStartupMs = 0.0
        $openMs = 0.0
        $exportMs = 0.0
        $recycled = $false
        try {
            if ($null -eq $word) {
                $wordStartupMs = Start-WordApplication
            }
            $sourcePath = [System.IO.Path]::GetFullPath([string]$request.source_path)
            $outputPath = [System.IO.Path]::GetFullPath([string]$request.output_path)

            $openTimer = [System.Diagnostics.Stopwatch]::StartNew()
            # ConfirmConversions=false, ReadOnly=true. UpdateLinksAtOpen is disabled
            # both here and on the Word application options.
            $document = $word.Documents.Open($sourcePath, $false, $true)
            $openTimer.Stop()
            $openMs = $openTimer.Elapsed.TotalMilliseconds

            $exportTimer = [System.Diagnostics.Stopwatch]::StartNew()
            $document.ExportAsFixedFormat($outputPath, 17)
            $exportTimer.Stop()
            $exportMs = $exportTimer.Elapsed.TotalMilliseconds
            $document.Close(0)
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
            $document = $null

            if (-not (Test-Path -LiteralPath $outputPath) -or (Get-Item -LiteralPath $outputPath).Length -eq 0) {
                throw "Microsoft Word did not create a complete PDF output."
            }

            $renderCount += 1
            if ($renderCount -ge $MaxRenders) {
                Stop-WordApplication
                $renderCount = 0
                $recycled = $true
            }
            $total.Stop()
            Send-WorkerMessage @{
                type = "result"
                ok = $true
                job_id = $jobId
                word_startup_ms = [Math]::Round($wordStartupMs, 2)
                document_open_ms = [Math]::Round($openMs, 2)
                pdf_export_ms = [Math]::Round($exportMs, 2)
                total_ms = [Math]::Round($total.Elapsed.TotalMilliseconds, 2)
                recycled = $recycled
            }
        } catch {
            $message = $_.Exception.Message
            Stop-WordApplication
            $renderCount = 0
            $total.Stop()
            Send-WorkerMessage @{
                type = "result"
                ok = $false
                job_id = $jobId
                category = "render_failed"
                error = $message
                total_ms = [Math]::Round($total.Elapsed.TotalMilliseconds, 2)
                worker_unusable = $true
            }
        }
    }
} catch {
    $workerStartedAt.Stop()
    Send-WorkerMessage @{
        type = "ready"
        ok = $false
        error = $_.Exception.Message
        worker_startup_ms = [Math]::Round($workerStartedAt.Elapsed.TotalMilliseconds, 2)
    }
} finally {
    Stop-WordApplication
}
