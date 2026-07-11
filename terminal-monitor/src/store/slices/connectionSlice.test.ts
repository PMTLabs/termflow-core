import connectionReducer, {
  setWsConnected,
  setApiConnected,
  setConnectionError,
  incrementReconnectAttempts,
} from './connectionSlice';

interface ConnectionState {
  wsConnected: boolean;
  apiConnected: boolean;
  reconnectAttempts: number;
  lastError: string | null;
}

describe('connectionSlice', () => {
  const initialState: ConnectionState = {
    wsConnected: false,
    apiConnected: true,
    reconnectAttempts: 0,
    lastError: null,
  };

  describe('reducer', () => {
    it('should return the initial state', () => {
      expect(connectionReducer(undefined, { type: 'unknown' })).toEqual(
        initialState
      );
    });
  });

  describe('setWsConnected', () => {
    it('should set connected to true and reset error', () => {
      const stateWithError: ConnectionState = {
        ...initialState,
        reconnectAttempts: 5,
        lastError: 'Connection failed',
      };
      const state = connectionReducer(stateWithError, setWsConnected(true));
      expect(state.wsConnected).toBe(true);
      expect(state.reconnectAttempts).toBe(0);
      expect(state.lastError).toBe(null);
    });

    it('should set connected to false', () => {
      const connectedState: ConnectionState = {
        ...initialState,
        wsConnected: true,
      };
      const state = connectionReducer(connectedState, setWsConnected(false));
      expect(state.wsConnected).toBe(false);
    });
  });

  describe('setConnectionError', () => {
    it('should set error message', () => {
      const errorMessage = 'Connection failed';
      const state = connectionReducer(
        initialState,
        setConnectionError(errorMessage)
      );
      expect(state.lastError).toBe(errorMessage);
    });

    it('should clear error message with null', () => {
      const stateWithError: ConnectionState = {
        ...initialState,
        lastError: 'Some error',
      };
      const state = connectionReducer(stateWithError, setConnectionError(null));
      expect(state.lastError).toBe(null);
    });
  });

  describe('incrementReconnectAttempts', () => {
    it('should increment reconnect attempts', () => {
      const state = connectionReducer(
        initialState,
        incrementReconnectAttempts()
      );
      expect(state.reconnectAttempts).toBe(1);
    });

    it('should increment from existing value', () => {
      const stateWithAttempts: ConnectionState = {
        ...initialState,
        reconnectAttempts: 3,
      };
      const state = connectionReducer(
        stateWithAttempts,
        incrementReconnectAttempts()
      );
      expect(state.reconnectAttempts).toBe(4);
    });
  });

  describe('setApiConnected', () => {
    it('should set API connected to true', () => {
      const disconnectedState: ConnectionState = {
        ...initialState,
        apiConnected: false,
      };
      const state = connectionReducer(disconnectedState, setApiConnected(true));
      expect(state.apiConnected).toBe(true);
    });

    it('should set API connected to false', () => {
      const state = connectionReducer(initialState, setApiConnected(false));
      expect(state.apiConnected).toBe(false);
    });
  });

  describe('combined scenarios', () => {
    it('should handle successful connection flow', () => {
      let state = initialState;

      // Connection attempt
      state = connectionReducer(state, incrementReconnectAttempts());
      expect(state.reconnectAttempts).toBe(1);

      // Connection succeeds
      state = connectionReducer(state, setWsConnected(true));

      expect(state.wsConnected).toBe(true);
      expect(state.reconnectAttempts).toBe(0); // Reset by setWsConnected(true)
      expect(state.lastError).toBe(null);
    });

    it('should handle connection failure and recovery', () => {
      let state = initialState;

      // First attempt fails
      state = connectionReducer(state, incrementReconnectAttempts());
      state = connectionReducer(
        state,
        setConnectionError('Connection refused')
      );

      expect(state.reconnectAttempts).toBe(1);
      expect(state.lastError).toBe('Connection refused');

      // Second attempt fails
      state = connectionReducer(state, incrementReconnectAttempts());
      expect(state.reconnectAttempts).toBe(2);

      // Third attempt succeeds
      state = connectionReducer(state, setWsConnected(true));

      expect(state.wsConnected).toBe(true);
      expect(state.reconnectAttempts).toBe(0); // Reset by setWsConnected(true)
      expect(state.lastError).toBe(null); // Reset by setWsConnected(true)
    });
  });
});
