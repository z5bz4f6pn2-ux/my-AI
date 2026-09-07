$ErrorActionPreference = "Stop"
$taskName = "Tom's AI Windows Companion"
$installFolder = Join-Path $env:LOCALAPPDATA "TomsAI"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

if (Test-Path -LiteralPath $installFolder) {
  Remove-Item -LiteralPath $installFolder -Recurse -Force
}

Write-Host "Tom's AI Windows companion was removed." -ForegroundColor Green
