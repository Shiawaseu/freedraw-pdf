$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $projectRoot "manifest.json"
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$pluginId = $manifest.id
$legacyPluginIds = @("handwriting-pdf", "pdf-annotator") | Where-Object { $_ -ne $pluginId }

$testVault = $env:OBSIDIAN_TEST_VAULT
if ([string]::IsNullOrWhiteSpace($testVault)) {
	$testVault = Join-Path $projectRoot "obsidian"
}

$files = @("manifest.json", "main.js", "styles.css")

$testVaults = @($testVault)

foreach ($vault in $testVaults) {
	$pluginDir = Join-Path $vault ".obsidian\plugins\$pluginId"
	New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

	foreach ($file in $files) {
		$source = Join-Path $projectRoot $file
		if (!(Test-Path -LiteralPath $source)) {
			throw "Missing plugin build file: $source"
		}
		Copy-Item -LiteralPath $source -Destination $pluginDir -Force
	}

	$communityPluginsPath = Join-Path $vault ".obsidian\community-plugins.json"
	$enabledPlugins = @()
	if (Test-Path -LiteralPath $communityPluginsPath) {
		try {
			$rawEnabledPlugins = @(Get-Content -Raw -LiteralPath $communityPluginsPath | ConvertFrom-Json)
		} catch {
			Write-Warning "Resetting malformed community-plugins.json in $vault"
			$rawEnabledPlugins = @()
		}
		foreach ($entry in $rawEnabledPlugins) {
			if ($entry -is [string]) {
				$enabledPlugins += $entry
				continue
			}
			if ($entry.PSObject.Properties.Name -contains "value") {
				$enabledPlugins += @($entry.value)
			}
		}
	}
	if ($enabledPlugins -notcontains $pluginId) {
		$enabledPlugins += $pluginId
	}
	$enabledPlugins = @($enabledPlugins | Where-Object { $_ -is [string] -and ![string]::IsNullOrWhiteSpace($_) -and $legacyPluginIds -notcontains $_ } | Select-Object -Unique)
	$jsonEntries = @($enabledPlugins | ForEach-Object { "  " + ($_ | ConvertTo-Json -Compress) })
	$json = if ($jsonEntries.Count -eq 0) {
		"[]"
	} else {
		"[`n" + ($jsonEntries -join ",`n") + "`n]"
	}
	$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
	[System.IO.File]::WriteAllText($communityPluginsPath, $json, $utf8NoBom)

	Write-Host "Deployed $pluginId to $pluginDir"
}
