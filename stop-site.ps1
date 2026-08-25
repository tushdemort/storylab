[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runtimeDirectory = Join-Path $PSScriptRoot ".runtime"
$statePath = Join-Path $runtimeDirectory "public-site.json"

if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host "No site processes started by start-site.ps1 were found." -ForegroundColor Yellow
  exit 0
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$targets = @(
  [pscustomobject]@{ Label = "Cloudflare tunnel"; ProcessId = $state.tunnelPid; ExpectedName = "cloudflared" },
  [pscustomobject]@{ Label = "Next.js server"; ProcessId = $state.serverPid; ExpectedName = "node" }
)

foreach ($target in $targets) {
  if ($null -eq $target.ProcessId) {
    if ($target.Label -eq "Next.js server") {
      Write-Host "Next.js was already running before the launcher, so it was left running." -ForegroundColor Yellow
    }
    continue
  }
  $runningProcess = Get-Process -Id ([int]$target.ProcessId) -ErrorAction SilentlyContinue
  if ($null -eq $runningProcess) {
    Write-Host "$($target.Label) is already stopped."
    continue
  }
  if ($runningProcess.ProcessName -ne $target.ExpectedName) {
    Write-Warning "PID $($target.ProcessId) now belongs to $($runningProcess.ProcessName); it was not stopped."
    continue
  }
  Stop-Process -Id $runningProcess.Id -Force
  Write-Host "Stopped $($target.Label)." -ForegroundColor Green
}

Remove-Item -LiteralPath $statePath -Force
Write-Host "Site launcher state cleared."
