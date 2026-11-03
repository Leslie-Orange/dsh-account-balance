param(
    [string]$OutputDirectory = (Split-Path -Parent $PSScriptRoot | Split-Path -Parent)
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne '@local/dsh-account-balance' -or $manifest.version -ne '1.1.0') {
    throw 'This release script packages @local/dsh-account-balance 1.1.0 only.'
}
if (@($manifest.scripts.PSObject.Properties.Name | Where-Object { $_ -notin @('test', 'check') }).Count -gt 0) {
    throw 'Unexpected package scripts; review before packaging.'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path

Push-Location -LiteralPath $projectDirectory
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed.' }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Syntax checks failed.' }
    $packOutput = & npm.cmd pack --ignore-scripts --json --pack-destination $resolvedOutput
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
    $packDocument = ($packOutput -join "`n") | ConvertFrom-Json
    if ($packDocument -is [array]) { $packResult = $packDocument[0] }
    elseif ($packDocument.filename) { $packResult = $packDocument }
    else { $packResult = $packDocument.PSObject.Properties[$manifest.name].Value }
    if (-not $packResult.filename) { throw 'npm pack did not return a package filename.' }
    $tarballPath = Join-Path $resolvedOutput $packResult.filename
    $expectedPackFiles = @(
        'LICENSE', 'README.md', 'RELEASE_NOTES.md', 'client.js', 'cordis.patch.yml',
        'icon.svg', 'index.js', 'locale/en.json', 'locale/zh.json', 'package.json'
    ) | Sort-Object
    $actualPackFiles = @($packResult.files | ForEach-Object { $_.path }) | Sort-Object
    if (Compare-Object $expectedPackFiles $actualPackFiles) { throw 'Unexpected tarball contents.' }

    $sourceEntries = @(
        '.gitignore', 'LICENSE', 'README.md', 'RELEASE_NOTES.md', 'package.json',
        'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale', 'tools'
    )
    $sourcePaths = @($sourceEntries | ForEach-Object { Join-Path $projectDirectory $_ })
    $sourceArchive = Join-Path $resolvedOutput 'dsh-account-balance-1.1.0-source.zip'
    Compress-Archive -LiteralPath $sourcePaths -DestinationPath $sourceArchive -CompressionLevel Optimal -Force
    $checksums = @($tarballPath, $sourceArchive) | ForEach-Object {
        $digest = Get-FileHash -LiteralPath $_ -Algorithm SHA256
        '{0}  {1}' -f $digest.Hash.ToLowerInvariant(), (Split-Path -Leaf $_)
    }
    $checksums | Set-Content -LiteralPath (Join-Path $resolvedOutput 'SHA256SUMS.txt') -Encoding ascii
    Write-Output "Release artifacts: $resolvedOutput"
    $checksums | Write-Output
} finally {
    Pop-Location
}
