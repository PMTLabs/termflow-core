@echo off
echo Cleaning and rebuilding Auto-Terminal...
echo.

echo Step 1: Killing any running processes on port 2010...
npx kill-port 2010
timeout /t 2

echo.
echo Step 2: Cleaning build directories...
if exist dist-electron rmdir /s /q dist-electron
if exist out rmdir /s /q out

echo.
echo Step 3: Building renderer...
call npm run build:renderer

echo.
echo Step 4: Starting application...
call npm run dev

echo.
echo Build complete! The application should now start with the latest changes.