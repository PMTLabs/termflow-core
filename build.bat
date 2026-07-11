@echo off
echo Building Auto-Terminal...

echo Building main process...
call npx cross-env NODE_ENV=production webpack --config webpack.main.config.js
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building preload script...
call npx cross-env NODE_ENV=production webpack --config webpack.preload.config.js
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building renderer process...
call npx cross-env NODE_ENV=production webpack --config webpack.renderer.config.js
if %errorlevel% neq 0 exit /b %errorlevel%

echo Build complete!