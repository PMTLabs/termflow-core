# PowerShell script to rebuild and start Auto-Terminal
Write-Host "Cleaning and rebuilding Auto-Terminal..." -ForegroundColor Green
Write-Host ""

Write-Host "Step 1: Killing any running processes on port 2010..." -ForegroundColor Yellow
npx kill-port 2010
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "Step 2: Cleaning build directories..." -ForegroundColor Yellow
if (Test-Path "dist-electron") {
    Remove-Item -Path "dist-electron" -Recurse -Force
}
if (Test-Path "out") {
    Remove-Item -Path "out" -Recurse -Force
}

Write-Host ""
Write-Host "Step 3: Building renderer..." -ForegroundColor Yellow
npm run build:renderer

Write-Host ""
Write-Host "Step 4: Starting application..." -ForegroundColor Yellow
npm run dev

Write-Host ""
Write-Host "Build complete! The application should now start with the latest changes." -ForegroundColor Green