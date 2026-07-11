@echo off
echo ========================================
echo   Testing Shared API with Auto-Terminal
echo ========================================
echo.

REM Step 1: Build the app
echo Step 1: Building the application...
call npm run build:main
call npm run build:preload
call npm run build:renderer

echo.
echo Step 2: Starting Auto-Terminal...
start "Auto-Terminal" cmd /c "npm start"

echo.
echo Waiting for app to start...
timeout /t 5 /nobreak > nul

echo.
echo Step 3: Starting API server in shared mode...
start "API Server" cmd /k "npm run api:dev"

echo.
echo Waiting for API to start...
timeout /t 5 /nobreak > nul

echo.
echo ========================================
echo Setup complete!
echo.
echo 1. Create some terminals in the Auto-Terminal app
echo 2. Copy the API token from the API server window
echo 3. Test with: node test-api-terminals.js YOUR_TOKEN
echo.
echo The API should now show terminals created in the app!
echo ========================================
echo.
pause