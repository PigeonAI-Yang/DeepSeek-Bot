[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApplicationPath,
    [string]$TargetHost = 'amr-link.open-design.ai',
    [switch]$VerifyEnvironment
)

$ErrorActionPreference = 'Stop'
$applicationDirectory = Split-Path -Path $ApplicationPath -Parent
$proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
$proxyBefore = foreach ($name in $proxyNames) {
    [pscustomobject]@{
        Name = $name
        Value = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
}

function Add-TargetHost {
    param(
        [AllowNull()]
        [string]$Existing,
        [Parameter(Mandatory)]
        [string]$HostName
    )

    if ([string]::IsNullOrWhiteSpace($Existing)) {
        return $HostName
    }

    foreach ($entry in ($Existing -split '[,\s]+')) {
        if ($entry.Trim().TrimStart('.') -ieq $HostName) {
            return $Existing
        }
    }

    return "$Existing,$HostName"
}

$inheritedUpper = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
$inheritedLower = [Environment]::GetEnvironmentVariable('no_proxy', 'Process')
$env:NO_PROXY = Add-TargetHost -Existing $inheritedUpper -HostName $TargetHost
$env:no_proxy = Add-TargetHost -Existing $inheritedLower -HostName $TargetHost
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if ($VerifyEnvironment) {
    $proxyUnchanged = $true
    foreach ($entry in $proxyBefore) {
        $current = [Environment]::GetEnvironmentVariable($entry.Name, 'Process')
        if (![object]::Equals($entry.Value, $current)) {
            $proxyUnchanged = $false
        }
    }

    $lowerNoProxy = [Environment]::GetEnvironmentVariable('no_proxy', 'Process')
    $upperNoProxy = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
    $lowerHasTarget = @($lowerNoProxy -split '[,\s]+' | Where-Object { $_.Trim().TrimStart('.') -ieq $TargetHost }).Count -gt 0
    $upperHasTarget = @($upperNoProxy -split '[,\s]+' | Where-Object { $_.Trim().TrimStart('.') -ieq $TargetHost }).Count -gt 0
    [pscustomobject]@{
        lowerNoProxyIncludesTarget = $lowerHasTarget
        upperNoProxyIncludesTarget = $upperHasTarget
        httpProxyVariablesUnchanged = $proxyUnchanged
        electronRunAsNodeRemoved = ($null -eq [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process'))
    } | ConvertTo-Json -Compress
    exit 0
}

if (!(Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw 'Installed DeepSeek Harness executable was not found.'
}

Start-Process -FilePath $ApplicationPath -WorkingDirectory $applicationDirectory -WindowStyle Normal
