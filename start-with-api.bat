@echo off
echo ========================================
echo   Auto-Terminal with API Server
echo ========================================
echo.

REM Check if we're in the right directory
if not exist "package.json" (
    echo ERROR: Please run this script from the Auto-Terminal project root directory
    pause
    exit /b 1
)

REM Set configuration
set JWT_SECRET=dev-secret-key
set API_PORT=3001
set WS_PORT=9876

REM Start API server in new window
echo Starting API server on port %API_PORT%...
start "Auto-Terminal API Server" cmd /k "npm run api:dev"

REM Wait for API to initialize
echo Waiting for API server to start...
timeout /t 5 /nobreak > nul

REM Check if packaged app exists
if exist "dist-electron\auto-terminal-win32-x64\auto-terminal.exe" (
    echo Starting packaged Auto-Terminal...
    cd dist-electron\auto-terminal-win32-x64
    start auto-terminal.exe
    cd ..\..
) else (
    echo.
    echo Packaged app not found. Starting development version...
    start "Auto-Terminal Dev" cmd /k "npm run dev"
)

echo.
echo ========================================
echo Auto-Terminal is running!
echo.
echo API Server: http://localhost:%API_PORT%
echo WebSocket: ws://localhost:%WS_PORT%
echo.
echo To test the API, copy a token from the API
echo server window and use it with curl or Postman
echo ========================================
echo.
echo Press any key to stop all services...
pause > nul

echo.
echo Stopping services...
taskkill /F /FI "WINDOWTITLE eq Auto-Terminal*" > nul 2>&1
echo Done.
pause