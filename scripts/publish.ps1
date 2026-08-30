#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string] $Message,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ExpectedRemote = "https://github.com/rio-csharp/pi-extensions.git"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stagedByScript = $false
$commitCreated = $false
Set-Location $repo

function Invoke-Git {
    $gitArguments = @($args)
    & git @gitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($gitArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-GitOutput {
    $gitArguments = @($args)
    $output = @(& git @gitArguments)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($gitArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
    return $output
}

function Invoke-Npm {
    $npmArguments = @($args)
    & npm @npmArguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($npmArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Assert-ExpectedOrigin {
    $fetchUrls = @(Get-GitOutput remote get-url --all origin)
    $pushUrls = @(Get-GitOutput remote get-url --push --all origin)
    if (
        $fetchUrls.Count -ne 1 -or
        $pushUrls.Count -ne 1 -or
        $fetchUrls[0] -cne $ExpectedRemote -or
        $pushUrls[0] -cne $ExpectedRemote
    ) {
        throw "origin must have exactly one fetch URL and one push URL, both equal to the explicitly expected URL '$ExpectedRemote'. Pass -ExpectedRemote only after independently verifying another canonical remote. Found fetch='$($fetchUrls -join ', ')', push='$($pushUrls -join ', ')'."
    }
    if ($fetchUrls[0] -match '(?i)k12-general' -or $pushUrls[0] -match '(?i)k12-general') {
        throw "Refusing to publish to a k12-general remote."
    }
}

function Get-IndexEntries {
    param([Parameter(Mandatory = $true)][string] $Path)
    return @(Get-GitOutput ls-files --stage -- ":(literal)$Path")
}

function Assert-RegularIndexBlob {
    param([Parameter(Mandatory = $true)][string] $Path)
    $entries = @(Get-IndexEntries $Path)
    if ($entries.Count -ne 1 -or $entries[0] -notmatch '^100(?:644|755) [0-9a-f]+ 0\t') {
        throw "Expected a regular stage-zero index blob for $Path."
    }
}

function Get-IndexBlobText {
    param([Parameter(Mandatory = $true)][string] $Path)
    Assert-RegularIndexBlob $Path
    # Read the prospective commit's blob, never the mutable working-tree file.
    return (@(Get-GitOutput show ":$Path") -join "`n")
}

try {
    if ($repo -match '(?i)(^|[\\/])k12-general([\\/]|$)' -or $Message -match '(?i)\bk12-general\b') {
        throw "Refusing to publish anything associated with private k12-general material."
    }

    $branch = (Get-GitOutput branch --show-current | Select-Object -First 1)
    if ($branch -ne "main") {
        throw "Publishing is allowed only from the main branch (current: '$branch')."
    }

    $head = (Get-GitOutput rev-parse HEAD | Select-Object -First 1)
    $mainHead = (Get-GitOutput rev-parse refs/heads/main | Select-Object -First 1)
    if ($head -ne $mainHead) {
        throw "HEAD is not the main branch tip."
    }

    & git diff --cached --quiet --exit-code
    if ($LASTEXITCODE -eq 1) {
        throw "The index is not clean. Commit or unstage existing staged changes before publishing."
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Could not verify that the index is clean."
    }

    Assert-ExpectedOrigin

    Invoke-Git fetch --prune origin
    Get-GitOutput rev-parse --verify refs/remotes/origin/main | Out-Null
    $counts = ((Get-GitOutput rev-list --left-right --count HEAD...origin/main | Select-Object -First 1) -split '\s+')
    $ahead = [int]$counts[0]
    $behind = [int]$counts[1]
    if ($behind -gt 0) {
        throw "origin/main is $behind commit(s) ahead. Pull or rebase before publishing."
    }
    if ($ahead -gt 0) {
        Write-Host "Existing outgoing commits:" -ForegroundColor Yellow
        Invoke-Git log --oneline origin/main..HEAD
        throw "HEAD already has $ahead outgoing commit(s). Review and publish those separately before creating a release commit."
    }

    Invoke-Git diff --check

    # Phase 1: reproduce installs and validate without changing Git history.
    Invoke-Npm ci --ignore-scripts
    Invoke-Npm --prefix extensions/mcp ci --ignore-scripts
    Invoke-Npm run check
    Invoke-Npm run audit
    Invoke-Npm audit
    Invoke-Npm --prefix extensions/mcp audit

    Write-Host "Working-tree paths proposed for staging:" -ForegroundColor Cyan
    Invoke-Git status --short

    Invoke-Git add -A
    $stagedByScript = $true

    $staged = @(Get-GitOutput diff --cached --name-only --diff-filter=ACMRT --)
    $allStaged = @(Get-GitOutput diff --cached --name-only --)
    if ($allStaged.Count -eq 0) {
        $stagedByScript = $false
        Write-Host "No changes to publish."
        return
    }

    $unsafeTreeEntries = @(Get-GitOutput ls-files --stage | Where-Object { $_ -match '^(?:120000|160000) ' })
    if ($unsafeTreeEntries.Count -gt 0) {
        throw "Refusing to publish a tree containing symlinks or gitlinks: $($unsafeTreeEntries -join '; ')"
    }

    $requiredStatuses = @{
        "package-lock.json" = '^[AM]$'
        "extensions/mcp/package-lock.json" = '^[AM]$'
        "extensions/mcp/commands.ts" = '^D$'
    }
    foreach ($requiredPath in $requiredStatuses.Keys) {
        $statusLines = @(Get-GitOutput diff --cached --name-status --no-renames -- ":(literal)$requiredPath")
        if ($statusLines.Count -ne 1) {
            throw "Required release change is missing or ambiguous: $requiredPath"
        }
        $status = ($statusLines[0] -split "`t", 2)[0]
        if ($status -notmatch $requiredStatuses[$requiredPath]) {
            throw "Unexpected staged status '$status' for required release path $requiredPath."
        }
    }
    foreach ($requiredNoticePath in @("LICENSE", "NOTICE")) {
        Assert-RegularIndexBlob $requiredNoticePath
    }
    foreach ($lockPath in @("package-lock.json", "extensions/mcp/package-lock.json")) {
        Assert-RegularIndexBlob $lockPath
    }
    $obsoleteEntries = @(Get-IndexEntries "extensions/mcp/commands.ts")
    if ($obsoleteEntries.Count -ne 0) {
        throw "extensions/mcp/commands.ts must be absent from the prospective release tree."
    }

    $forbiddenNames = @(
        "auth.json",
        ".credentials.json",
        "models-store.json",
        "relay-providers.json",
        "mcp-config.json",
        "settings.json",
        "k12-general.md"
    )
    foreach ($relativePath in $allStaged) {
        $leaf = Split-Path $relativePath -Leaf
        if ($forbiddenNames -contains $leaf -or $relativePath -match '(?i)(^|/)k12-general(?:\.md)?(?:/|$)') {
            throw "Refusing to publish private Pi state: $relativePath"
        }
    }

    $secretPatterns = @(
        'sk-[A-Za-z0-9_-]{20,}',
        'Bearer\s+[A-Za-z0-9._~+/=-]{20,}',
        'ghp_[A-Za-z0-9]{20,}',
        'github_pat_[A-Za-z0-9_]{20,}',
        'AKIA[A-Z0-9]{16}',
        'AIza[A-Za-z0-9_-]{30,}',
        '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        '"(?:apiKey|accessToken|token|secret|password)"\s*:\s*"(?!PASTE_|YOUR_|EXAMPLE_|\$[A-Z_][A-Z0-9_]*"|\$\{)[^"\r\n]{12,}"'
    )

    foreach ($relativePath in $staged) {
        $text = Get-IndexBlobText $relativePath
        if ($relativePath -notin @("README.md", "scripts/publish.ps1") -and $text -match '(?i)\bk12-general\b') {
            throw "Refusing to publish a k12-general reference in $relativePath."
        }
        foreach ($pattern in $secretPatterns) {
            if ($text -match $pattern) {
                throw "Possible credential found in staged index blob $relativePath. Review the file before publishing."
            }
        }
    }

    Invoke-Git diff --cached --check
    $reviewedIndexTree = (Get-GitOutput write-tree | Select-Object -First 1)

    # Phase 2: make the exact staged release reviewable before any commit or push.
    Write-Host "`nStaged release summary:" -ForegroundColor Cyan
    Invoke-Git status --short
    Invoke-Git diff --cached --stat
    Invoke-Git diff --cached --summary
    Write-Host "Reviewed staged tree: $reviewedIndexTree" -ForegroundColor Cyan
    Write-Host "`nNo commit or push has occurred. Review the staged diff now with: git diff --cached" -ForegroundColor Yellow
    $confirmation = Read-Host "Type PUBLISH to commit '$Message' and push HEAD to $ExpectedRemote main"
    if ($confirmation -cne "PUBLISH") {
        throw "Publish canceled."
    }

    Assert-ExpectedOrigin
    $currentHead = (Get-GitOutput rev-parse HEAD | Select-Object -First 1)
    if ($currentHead -ne $head) {
        throw "HEAD changed during review; nothing was committed or pushed."
    }
    $remoteHeadLines = @(Get-GitOutput ls-remote origin refs/heads/main)
    if ($remoteHeadLines.Count -ne 1) {
        throw "Could not resolve exactly one live origin/main ref; nothing was committed or pushed."
    }
    $liveRemoteHead = ($remoteHeadLines[0] -split '\s+')[0]
    if ($liveRemoteHead -ne $head) {
        throw "origin/main changed during review; nothing was committed or pushed. Fetch and review again."
    }

    $currentIndexTree = (Get-GitOutput write-tree | Select-Object -First 1)
    if ($currentIndexTree -ne $reviewedIndexTree) {
        throw "The staged tree changed during review; nothing was committed or pushed."
    }

    $preCommitHead = $head
    Invoke-Git commit -m $Message
    $commitCreated = $true
    $stagedByScript = $false

    & git diff --cached --quiet --exit-code
    if ($LASTEXITCODE -ne 0) {
        throw "The index changed unexpectedly after commit; nothing was pushed."
    }

    $newHead = (Get-GitOutput rev-parse HEAD | Select-Object -First 1)
    $parent = (Get-GitOutput rev-parse "HEAD^" | Select-Object -First 1)
    $committedTree = (Get-GitOutput rev-parse "HEAD^{tree}" | Select-Object -First 1)
    $outgoing = [int](Get-GitOutput rev-list --count origin/main..HEAD | Select-Object -First 1)
    if ($newHead -eq $preCommitHead -or $parent -ne $preCommitHead -or $outgoing -ne 1) {
        throw "Unexpected HEAD/outgoing state after commit; nothing was pushed. Review git log origin/main..HEAD."
    }
    if ($committedTree -ne $reviewedIndexTree) {
        throw "The commit tree differs from the reviewed staged tree; nothing was pushed."
    }

    Write-Host "Outgoing commit to push:" -ForegroundColor Cyan
    Invoke-Git log --oneline --decorate origin/main..HEAD
    Assert-ExpectedOrigin
    Invoke-Git push origin HEAD:refs/heads/main

    $remoteHeadLine = (Get-GitOutput ls-remote origin refs/heads/main | Select-Object -First 1)
    $remoteHead = ($remoteHeadLine -split '\s+')[0]
    if ($remoteHead -ne $newHead) {
        throw "Push returned successfully, but origin/main does not resolve to the committed HEAD."
    }

    Invoke-Git status --short --branch
    Write-Host "Published successfully: $newHead" -ForegroundColor Green
} finally {
    if ($stagedByScript -and -not $commitCreated) {
        & git reset --mixed --quiet HEAD
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Restored the initially clean index; working-tree changes were retained." -ForegroundColor Yellow
        } else {
            Write-Warning "Could not restore the index automatically. Run 'git reset HEAD' after reviewing it."
        }
    }
}
