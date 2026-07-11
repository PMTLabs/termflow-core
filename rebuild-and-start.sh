#!/bin/bash
echo "Cleaning and rebuilding Auto-Terminal..."
echo

echo "Step 1: Killing any running processes on port 2010..."
npx kill-port 2010
sleep 2

echo
echo "Step 2: Cleaning build directories..."
rm -rf dist-electron out

echo
echo "Step 3: Building renderer..."
npm run build:renderer

echo
echo "Step 4: Starting application..."
npm run dev

echo
echo "Build complete! The application should now start with the latest changes."