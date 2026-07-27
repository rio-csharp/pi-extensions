[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string] $Message
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repo

function Invoke-Git {
    $gitArguments = @($args)
    & git @gitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($gitArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if ((& git branch --show-current) -ne "main") {
    throw "Publishing is allowed only from the main branch."
}

Invoke-Git fetch origin
$behind = [int](& git rev-list --count HEAD..origin/main)
if ($LASTEXITCODE -ne 0) { throw "Could not compare the local branch with origin/main." }
if ($behind -gt 0) {
    throw "origin/main is $behind commit(s) ahead. Pull or rebase before publishing."
}

Invoke-Git add -A

$staged = @(& git diff --cached --name-only --diff-filter=ACMR)
if ($LASTEXITCODE -ne 0) { throw "Could not list staged files." }

$forbiddenNames = @(
    "auth.json",
    ".credentials.json",
    "models-store.json",
    "relay-providers.json",
    "mcp-config.json",
    "settings.json"
)

foreach ($relativePath in $staged) {
    $leaf = Split-Path $relativePath -Leaf
    if ($forbiddenNames -contains $leaf) {
        throw "Refusing to publish private Pi state: $relativePath"
    }

    $fullPath = Join-Path $repo $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }

    $text = [System.IO.File]::ReadAllText($fullPath)
    $secretPatterns = @(
        'sk-[A-Za-z0-9_-]{20,}',
        'Bearer\s+[A-Za-z0-9._~+/=-]{20,}',
        '"(?:apiKey|accessToken|token|secret|password)"\s*:\s*"(?!PASTE_|YOUR_|EXAMPLE_|\$\{)[^"\r\n]{12,}"'
    )
    foreach ($pattern in $secretPatterns) {
        if ($text -match $pattern) {
            throw "Possible credential found in $relativePath. Review the file before publishing."
        }
    }
}

& git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw "The staged diff failed Git's whitespace/error check." }

if ($staged.Count -gt 0) {
    Invoke-Git commit -m $Message
} else {
    Write-Host "No uncommitted changes to commit."
}

Invoke-Git push origin main
Invoke-Git status --short --branch
Write-Host "Published successfully: $repo" -ForegroundColor Green
