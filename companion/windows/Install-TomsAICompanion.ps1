param(
  [string]$ServiceUrl = "https://my-ai-device.z5bz4f6pn2.workers.dev"
)

$ErrorActionPreference = "Stop"
$serviceUri = [Uri]$ServiceUrl
if ($serviceUri.Scheme -ne "https") {
  throw "The Tom's AI companion service must use HTTPS."
}

$secureToken = Read-Host "Paste the one-time device token from Tom's AI settings" -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $deviceToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}

if ($deviceToken -notmatch '^[A-Za-z0-9_-]{32,}$') {
  throw "That device token is not valid. Create a new one in Tom's AI settings."
}

$sourceScript = Join-Path $PSScriptRoot "TomsAICompanion.ps1"
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
  throw "Keep TomsAICompanion.ps1 in the same folder as this installer."
}

$installFolder = Join-Path $env:LOCALAPPDATA "TomsAI"
$configPath = Join-Path $installFolder "config.json"
$installedScript = Join-Path $installFolder "TomsAICompanion.ps1"
[IO.Directory]::CreateDirectory($installFolder) | Out-Null
Copy-Item -LiteralPath $sourceScript -Destination $installedScript -Force

@{
  serviceUrl = $serviceUri.AbsoluteUri.TrimEnd("/")
  deviceToken = $deviceToken
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
$deviceToken = $null

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $currentIdentity,
  "FullControl",
  "ContainerInherit,ObjectInherit",
  "None",
  "Allow"
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $installFolder -AclObject $acl

$taskName = "Tom's AI Windows Companion"
$powerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installedScript`""
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Tom's AI is connected to this Windows computer." -ForegroundColor Green
Write-Host "The companion will start automatically when you sign in."
