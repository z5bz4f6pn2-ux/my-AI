param(
  [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA "TomsAI\config.json")
)

$ErrorActionPreference = "Stop"

function Get-TomsAIConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Tom's AI is not paired. Run Install-TomsAICompanion.ps1 first."
  }

  $settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $serviceUri = [Uri]$settings.serviceUrl
  if ($serviceUri.Scheme -ne "https") {
    throw "The Tom's AI companion service must use HTTPS."
  }
  if ([string]::IsNullOrWhiteSpace([string]$settings.deviceToken)) {
    throw "The Tom's AI device token is missing."
  }
  return $settings
}

$script:Config = Get-TomsAIConfig
$script:Headers = @{ Authorization = "Bearer $($script:Config.deviceToken)" }
$script:LastHeartbeat = [DateTime]::MinValue

function Invoke-TomsAIApi {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("GET", "POST")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )

  $baseUri = ([string]$script:Config.serviceUrl).TrimEnd("/")
  $parameters = @{
    Uri = "$baseUri$Path"
    Method = $Method
    Headers = $script:Headers
    TimeoutSec = 20
    UseBasicParsing = $true
  }

  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 5 -Compress
  }

  return Invoke-RestMethod @parameters
}

function Confirm-TomsAIAction {
  param([Parameter(Mandatory = $true)][string]$Message)

  $shell = New-Object -ComObject WScript.Shell
  $choice = $shell.Popup(
    $Message,
    30,
    "Tom's AI needs your approval",
    4 + 32 + 4096
  )
  return $choice -eq 6
}

function Open-TomsAIApp {
  param([Parameter(Mandatory = $true)][string]$App)

  $apps = @{
    calculator = "calc.exe"
    notepad = "notepad.exe"
    settings = "ms-settings:"
    files = "explorer.exe"
    explorer = "explorer.exe"
    browser = "https://www.google.co.uk"
    edge = "msedge.exe"
    chrome = "chrome.exe"
    paint = "mspaint.exe"
    word = "winword.exe"
    excel = "excel.exe"
    spotify = "spotify.exe"
  }

  $key = $App.Trim().ToLowerInvariant()
  if (-not $apps.ContainsKey($key)) {
    throw "That app is not on Tom's AI's safe app list."
  }

  Start-Process $apps[$key]
  return "Opened $App."
}

function Open-TomsAIUrl {
  param([Parameter(Mandatory = $true)][string]$Url)

  $uri = [Uri]$Url
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @("http", "https")) {
    throw "Tom's AI only opens normal HTTP or HTTPS links."
  }

  Start-Process $uri.AbsoluteUri
  return "Opened $($uri.Host)."
}

function Open-TomsAIFile {
  param([Parameter(Mandatory = $true)][string]$Query)

  $safeQuery = $Query.Trim()
  if (
    [string]::IsNullOrWhiteSpace($safeQuery) -or
    $safeQuery.Length -gt 120 -or
    $safeQuery.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    $safeQuery.Contains("\") -or
    $safeQuery.Contains("/")
  ) {
    throw "That file search is not safe to run."
  }

  $allowedExtensions = @(
    ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp3", ".wav", ".mp4", ".mov"
  )
  $roots = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("MyDocuments"),
    [Environment]::GetFolderPath("MyPictures"),
    (Join-Path $env:USERPROFILE "Downloads")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique

  $match = @(foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -like "*$safeQuery*" -and
        $allowedExtensions -contains $_.Extension.ToLowerInvariant()
      }
  }) | Sort-Object LastWriteTime -Descending | Select-Object -First 1

  if (-not $match) {
    throw "I couldn't find a safe document or media file matching '$safeQuery'."
  }

  Start-Process $match.FullName
  return "Opened $($match.Name)."
}

function Initialize-VolumeControl {
  if (-not ("TomsAI.NativeAudio" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace TomsAI {
  public static class NativeAudio {
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    public static void Press(byte key) {
      keybd_event(key, 0, 0, UIntPtr.Zero);
      keybd_event(key, 0, 2, UIntPtr.Zero);
    }
  }
}
"@
  }
}

function Set-TomsAIVolume {
  param([Parameter(Mandatory = $true)][ValidateSet("up", "down", "mute")][string]$Change)

  Initialize-VolumeControl
  $key = switch ($Change) {
    up { 0xAF }
    down { 0xAE }
    mute { 0xAD }
  }
  [TomsAI.NativeAudio]::Press([byte]$key)
  return "Volume $Change."
}

function Save-TomsAIScreenshot {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $folder = Join-Path ([Environment]::GetFolderPath("MyPictures")) "Tom's AI Screenshots"
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    $path = Join-Path $folder ("Screenshot-{0}.png" -f (Get-Date -Format "yyyy-MM-dd-HHmmss"))
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    return "Screenshot saved to $path."
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Invoke-TomsAICommand {
  param([Parameter(Mandatory = $true)][object]$Command)

  switch ([string]$Command.action) {
    "open_app" { return Open-TomsAIApp -App ([string]$Command.payload.app) }
    "open_url" { return Open-TomsAIUrl -Url ([string]$Command.payload.url) }
    "open_file" { return Open-TomsAIFile -Query ([string]$Command.payload.query) }
    "volume_up" { return Set-TomsAIVolume -Change "up" }
    "volume_down" { return Set-TomsAIVolume -Change "down" }
    "volume_mute" { return Set-TomsAIVolume -Change "mute" }
    "screenshot" { return Save-TomsAIScreenshot }
    "lock" {
      if (-not (Confirm-TomsAIAction "Lock this computer now?")) { throw [OperationCanceledException]::new("You did not approve locking the computer.") }
      rundll32.exe user32.dll,LockWorkStation
      return "Computer locked."
    }
    "restart" {
      if (-not (Confirm-TomsAIAction "Restart this computer now? Unsaved work could be lost.")) { throw [OperationCanceledException]::new("You did not approve restarting the computer.") }
      & "$env:SystemRoot\System32\shutdown.exe" /r /t 0
      return "Computer restarting."
    }
    "shutdown" {
      if (-not (Confirm-TomsAIAction "Shut down this computer now? Unsaved work could be lost.")) { throw [OperationCanceledException]::new("You did not approve shutting down the computer.") }
      & "$env:SystemRoot\System32\shutdown.exe" /s /t 0
      return "Computer shutting down."
    }
    default { throw "Tom's AI refused an unknown action." }
  }
}

function Send-TomsAIResult {
  param(
    [Parameter(Mandatory = $true)][string]$CommandId,
    [Parameter(Mandatory = $true)][ValidateSet("completed", "failed", "rejected")][string]$Status,
    [string]$Result = "",
    [string]$ErrorText = ""
  )

  Invoke-TomsAIApi -Method POST -Path "/api/device/commands/$CommandId/result" -Body @{
    status = $Status
    result = $Result
    error = $ErrorText
  } | Out-Null
}

while ($true) {
  try {
    if (((Get-Date) - $script:LastHeartbeat).TotalSeconds -ge 30) {
      Invoke-TomsAIApi -Method POST -Path "/api/device/heartbeat" -Body @{} | Out-Null
      $script:LastHeartbeat = Get-Date
    }

    $next = Invoke-TomsAIApi -Method GET -Path "/api/device/commands/next"
    if ($next.command) {
      try {
        $result = Invoke-TomsAICommand -Command $next.command
        Send-TomsAIResult -CommandId $next.command.id -Status completed -Result $result
      } catch [OperationCanceledException] {
        Send-TomsAIResult -CommandId $next.command.id -Status rejected -ErrorText $_.Exception.Message
      } catch {
        Send-TomsAIResult -CommandId $next.command.id -Status failed -ErrorText $_.Exception.Message
      }
    }

    Start-Sleep -Milliseconds 900
  } catch {
    Write-Warning $_.Exception.Message
    Start-Sleep -Seconds 5
  }
}
