@echo off
echo Building main process...
call npm run build:main
echo.
echo Build complete. Checking output...
dir dist\main\main.js
pause