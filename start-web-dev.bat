@echo off
echo Starting Auto-Terminal Web Development Environment...
echo.

echo Step 1: Killing any running processes on ports...
call npx kill-port 42010
call npx kill-port 42031

echo.
echo Step 2: Starting Rust Backend (Headless)...
start "Auto-Terminal Backend" cmd /k "cd src-tauri && cargo run -- --headless"

echo.
echo Step 3: Waiting for backend to initialize...
timeout /t 5

echo.
echo Step 4: Starting Frontend...
echo Access the terminal at http://localhost:42010
call npm run dev:renderer
