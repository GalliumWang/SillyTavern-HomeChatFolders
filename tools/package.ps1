param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Missing manifest.json'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $version) {
    throw 'Missing version in manifest.json'
}

if (-not $OutputPath) {
    $distDir = Join-Path $projectRoot 'dist'
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    $OutputPath = Join-Path $distDir "SillyTavern-HomeChatFolders-v$version.zip"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$parentDir = Split-Path -Path $OutputPath -Parent
if ($parentDir -and -not (Test-Path -LiteralPath $parentDir -PathType Container)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

$rootFiles = @('manifest.json', 'index.js', 'style.css', 'README.md', 'CHANGELOG.md', 'LICENSE')
$srcFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Filter '*.js' -File |
    Sort-Object -Property Name |
    ForEach-Object { 'src/' + $_.Name }
$files = @($rootFiles + $srcFiles)

foreach ($file in $files) {
    $full = Join-Path $projectRoot ($file -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw "Missing runtime file: $file"
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# CreateNew deliberately prevents overwriting an existing release package.
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $source = Join-Path $projectRoot ($file -replace '/', [IO.Path]::DirectorySeparatorChar)
        $entry = 'SillyTavern-HomeChatFolders/' + ($file -replace '\\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $entry) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}

$verify = [IO.Compression.ZipFile]::OpenRead($OutputPath)
try {
    if ($verify.Entries.Count -ne $files.Count) {
        throw "ZIP entry count mismatch: expected $($files.Count), got $($verify.Entries.Count)"
    }
    foreach ($entry in $verify.Entries) {
        if (-not $entry.FullName.StartsWith('SillyTavern-HomeChatFolders/') -or $entry.FullName.Contains('..')) {
            throw "Invalid ZIP entry path: $($entry.FullName)"
        }
    }
} finally {
    $verify.Dispose()
}

Write-Output $OutputPath
