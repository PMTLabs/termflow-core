# Terminal Monitor

A React-based web application for monitoring and controlling headless Auto-Terminal instances.

## Features

- **JWT Authentication** for secure API access
- Real-time terminal output monitoring via WebSocket
- Multi-terminal management with list view
- Interactive terminal input with command history
- Special key support (Ctrl+C, Ctrl+D, ESC, TAB)
- Dark theme optimized for terminal viewing
- Connection status indicators
- Terminal creation and deletion
- Protected routes and session management

## Prerequisites

- Auto-Terminal running in headless mode
- Node.js and npm installed

## Installation

1. Navigate to the terminal-monitor directory:
```bash
cd terminal-monitor
```

2. Install dependencies:
```bash
npm install
```

## Running the Application

1. First, start Auto-Terminal with API enabled:
```bash
# From the auto-terminal directory
# Development mode:
npm run dev

# Or production mode:
npm run build
npm run start -- --enable-api
```

2. In a new terminal, start the React application:
```bash
# From the terminal-monitor directory
npm start
```

3. Open your browser to http://localhost:42030

4. The application will redirect to the login page where you can connect using a Client ID

## Architecture

- **React** with TypeScript for the UI
- **Redux Toolkit** for state management
- **Material-UI** for components and theming
- **xterm.js** for terminal display
- **Socket.io** for real-time WebSocket communication
- **Axios** for REST API calls with authentication interceptors
- **JWT** for secure API authentication
- **React Router** for client-side routing and protected routes

## API Configuration

The application expects the following services to be running:
- **Terminal Monitor**: http://localhost:42030 (React frontend)
- **REST API**: http://localhost:42031 (Tauri backend)
- **WebSocket**: ws://localhost:42031/api/ws (Tauri backend)

These are configured in the `.env` file. See `.env.example` for all available settings.

## Available Scripts

- `npm start` - Runs the app in development mode
- `npm build` - Builds the app for production
- `npm test` - Runs the test suite
- `npm eject` - Ejects from Create React App (not reversible)

## Usage

1. **Create Terminal**: Click "New Terminal" in the header
2. **Select Terminal**: Click on a terminal in the list
3. **Send Commands**: Type in the input field and press Enter
4. **Special Keys**: Use the buttons for Ctrl+C, Ctrl+D, ESC, TAB
5. **Delete Terminal**: Click the delete icon next to a terminal

## Authentication

The application uses JWT authentication to secure API access:

1. **Login**: On first visit, you'll be redirected to the login page
2. **Client ID**: Enter a client ID (default: "terminal-monitor")
3. **Token Storage**: JWT tokens are stored in localStorage
4. **Auto-refresh**: Tokens are automatically refreshed before expiry
5. **Protected Routes**: All dashboard routes require authentication

## Testing Authentication

Run the test script to verify authentication is working:
```bash
node test-auth.js
```

## Development

The application is structured as follows:
- `src/components/` - React components
- `src/store/` - Redux store and slices
- `src/services/` - WebSocket and API services (including auth)
- `src/types/` - TypeScript type definitions