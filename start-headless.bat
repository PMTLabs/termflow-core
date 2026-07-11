@echo off
echo Starting Auto-Terminal in headless mode...
echo.
echo API will be available at:
echo - REST API: http://localhost:3001
echo - WebSocket: ws://localhost:9876
echo - Direct API: http://localhost:3002
echo.
echo Press Ctrl+C to stop the application.
echo.

npm start -- --headless