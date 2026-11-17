param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'agy-capsule'))

# Validate the exact recursive-copy/delete target; never traverse a plugin link.
if ((Split-Path -Parent $destination) -ne $pluginRoot -or (Split-Path -Leaf $destination) -ne 'agy-capsule') {
    throw "Invalid plugin destination: $destination"
}
if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Plugin destination is a link. Remove the link manually first: $destination"
}

if ($Action -eq 'uninstall') {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Host "Removed agy-capsule from $destination"
    } else {
        Write-Host "Not installed: $destination"
    }
    Write-Host 'Preferences were kept. Reload open Antigravity pages to clear any remaining UI.'
    exit 0
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\agy-capsule')).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) {
    throw "Source plugin manifest missing: $source\plugin.json"
}
if ($source -eq $destination) { throw 'Source and destination must be different directories.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$marker = Join-Path $destination '.update-in-progress'
Set-Content -LiteralPath $marker -Value 'Updating agy-capsule' -Encoding ASCII
try {
    & robocopy.exe $source $destination /MIR /XJ /XF .update-in-progress /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    if ($LASTEXITCODE -ge 8) { throw "Plugin copy failed (robocopy exit code $LASTEXITCODE)." }
} finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
Write-Host "Installed/updated agy-capsule at $destination"
Write-Host 'Enable it in Antigravity Plugins on first install. Updates auto-restart a running reload-enabled version.'
exit 0
