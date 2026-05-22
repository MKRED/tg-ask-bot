$proxyUrl = "http://127.0.0.1:2080"
$current = [Environment]::GetEnvironmentVariable("HTTP_PROXY", "User")

if ($current) {
    [Environment]::SetEnvironmentVariable("HTTP_PROXY", $null, "User")
    [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $null, "User")
    Write-Host "Proxy OFF" -ForegroundColor Red
} else {
    [Environment]::SetEnvironmentVariable("HTTP_PROXY", $proxyUrl, "User")
    [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $proxyUrl, "User")
    Write-Host "Proxy ON  -> $proxyUrl" -ForegroundColor Green
}

Write-Host "Restart terminal for changes to take effect." -ForegroundColor Yellow
