[CmdletBinding()]
param(
  [ValidateRange(30, 300)]
  [int]$StartupTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$statePath = Join-Path $runtimeDirectory "public-site.json"
$localUrl = "http://127.0.0.1:3000"
$healthUrl = "$localUrl/api/study"
$serverProcess = $null
$tunnelProcess = $null
$serverStartedHere = $false

function Test-WebEndpoint([string]$Url, [int]$TimeoutSeconds = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Test-RunningProcess([object]$ProcessId, [string]$ExpectedName) {
  if ($null -eq $ProcessId) { return $false }
  $runningProcess = Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue
  return $null -ne $runningProcess -and $runningProcess.ProcessName -eq $ExpectedName
}

function Read-CombinedLog([string]$StandardOutputPath, [string]$StandardErrorPath) {
  $content = ""
  if (Test-Path -LiteralPath $StandardOutputPath) {
    $content += Get-Content -LiteralPath $StandardOutputPath -Raw -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $StandardErrorPath) {
    $content += Get-Content -LiteralPath $StandardErrorPath -Raw -ErrorAction SilentlyContinue
  }
  return $content
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

if (Test-Path -LiteralPath $statePath) {
  try {
    $previousState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $previousServerRunning = Test-RunningProcess $previousState.serverPid "node"
    $previousTunnelRunning = Test-RunningProcess $previousState.tunnelPid "cloudflared"
    if ($previousServerRunning -or $previousTunnelRunning) {
      Write-Host "The site launcher is already running." -ForegroundColor Yellow
      if ($previousState.localUrl) { Write-Host "Local:  $($previousState.localUrl)" }
      if ($previousState.publicUrl) { Write-Host "Public: $($previousState.publicUrl)" -ForegroundColor Cyan }
      Write-Host "Run .\stop-site.ps1 before starting it again."
      exit 0
    }
    Remove-Item -LiteralPath $statePath -Force
  } catch {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
}

try {
  $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
  $nextEntry = Join-Path $projectRoot "node_modules\next\dist\bin\next"

  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".env.local"))) {
    throw "Missing .env.local. Add the Supabase environment variables before starting the site."
  }

  if (-not (Test-Path -LiteralPath $nextEntry)) {
    Write-Host "Installing project dependencies..." -ForegroundColor Yellow
    & $npmCommand install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
  }

  $cloudflaredCandidates = @(
    (Get-Command cloudflared.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
    "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    "C:\Program Files\cloudflared\cloudflared.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  $cloudflaredCommand = $cloudflaredCandidates | Select-Object -First 1
  if (-not $cloudflaredCommand) {
    throw "cloudflared.exe was not found. Install Cloudflare Tunnel before running this script."
  }

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $serverOutputPath = Join-Path $runtimeDirectory "next-$timestamp.log"
  $serverErrorPath = Join-Path $runtimeDirectory "next-$timestamp.error.log"
  $tunnelOutputPath = Join-Path $runtimeDirectory "cloudflared-$timestamp.log"
  $tunnelErrorPath = Join-Path $runtimeDirectory "cloudflared-$timestamp.error.log"

  if (Test-WebEndpoint $healthUrl) {
    Write-Host "Using the Next.js server already running on port 3000." -ForegroundColor Yellow
  } else {
    Write-Host "Starting the Next.js server..."
    $serverProcess = Start-Process -FilePath $nodeCommand `
      -ArgumentList @("`"$nextEntry`"", "dev") `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $serverOutputPath `
      -RedirectStandardError $serverErrorPath `
      -PassThru
    $serverStartedHere = $true

    $serverDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while (-not (Test-WebEndpoint $healthUrl)) {
      $serverProcess.Refresh()
      if ($serverProcess.HasExited) {
        throw "Next.js exited before it became ready. Check $serverErrorPath"
      }
      if ((Get-Date) -ge $serverDeadline) {
        throw "Next.js did not become ready within $StartupTimeoutSeconds seconds. Check $serverErrorPath"
      }
      Start-Sleep -Milliseconds 500
    }
  }

  Write-Host "Starting the Cloudflare Quick Tunnel..."
  $tunnelProcess = Start-Process -FilePath $cloudflaredCommand `
    -ArgumentList @("tunnel", "--url", $localUrl, "--no-autoupdate") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelOutputPath `
    -RedirectStandardError $tunnelErrorPath `
    -PassThru

  $publicUrl = $null
  $tunnelDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while (-not $publicUrl) {
    $tunnelProcess.Refresh()
    if ($tunnelProcess.HasExited) {
      throw "cloudflared exited before creating a tunnel. Check $tunnelErrorPath"
    }
    $tunnelLog = Read-CombinedLog $tunnelOutputPath $tunnelErrorPath
    $urlMatch = [regex]::Match($tunnelLog, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($urlMatch.Success) { $publicUrl = $urlMatch.Value }
    if ((Get-Date) -ge $tunnelDeadline) {
      throw "Cloudflare did not provide a public URL within $StartupTimeoutSeconds seconds. Check $tunnelErrorPath"
    }
    if (-not $publicUrl) { Start-Sleep -Milliseconds 500 }
  }

  $publicDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while (-not (Test-WebEndpoint $publicUrl 10)) {
    $tunnelProcess.Refresh()
    if ($tunnelProcess.HasExited) {
      throw "The Cloudflare tunnel stopped before the public page became reachable."
    }
    if ((Get-Date) -ge $publicDeadline) {
      throw "The public page did not become reachable within $StartupTimeoutSeconds seconds."
    }
    Start-Sleep -Seconds 1
  }

  $storedServerPid = if ($serverStartedHere) { $serverProcess.Id } else { $null }
  [ordered]@{
    serverPid = $storedServerPid
    tunnelPid = $tunnelProcess.Id
    localUrl = $localUrl
    publicUrl = $publicUrl
    serverOutputLog = $serverOutputPath
    serverErrorLog = $serverErrorPath
    tunnelOutputLog = $tunnelOutputPath
    tunnelErrorLog = $tunnelErrorPath
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

  Write-Host ""
  Write-Host "Site is ready." -ForegroundColor Green
  Write-Host "Local:  $localUrl"
  Write-Host "Public: $publicUrl" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Run .\stop-site.ps1 to stop the server and tunnel."
} catch {
  if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
    Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($serverStartedHere -and $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Write-Error $_
  exit 1
}
