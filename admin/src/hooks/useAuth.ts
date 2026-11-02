import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, SESSION_SIGNAL_EVENT, api, type SessionSignalCode, type UserContext } from '../lib/api';
import { readStoredToken, storeToken } from '../lib/auth';

type AuthContextValue = {
  token: string | null;
  user: UserContext | null;
  loading: boolean;
  // /auth/me could not be reached (network/5xx): the token is kept and the session is unknown, not expired.
  sessionError: boolean;
  retrySession: () => void;
  // Why the session ended without the user asking for it (shown on the login screen); null otherwise.
  sessionMessage: string | null;
  // USER-MGMT-01 U5: after POST /auth/change-password the NEW token replaces the old one and /auth/me is re-read with it.
  adoptAccessToken: (accessToken: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const INACTIVE_MESSAGE = 'Tu usuario fue desactivado. Consultá con un administrador.';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initialToken] = useState(readStoredToken);
  const [token, setToken] = useState<string | null>(initialToken);
  const [user, setUser] = useState<UserContext | null>(null);
  // A stored token is only a candidate: the session is not restored until /auth/me accepts it.
  const [loading, setLoading] = useState(initialToken !== null);
  const [sessionError, setSessionError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [sessionMessage, setSessionMessage] = useState<string | null>(null);

  const logout = useCallback(() => {
    storeToken(null);
    setToken(null);
    setUser(null);
  }, []);

  const endInactive = useCallback(() => {
    storeToken(null);
    setToken(null);
    setUser(null);
    setSessionMessage(INACTIVE_MESSAGE);
  }, []);

  // One place for the "this session cannot continue" answers of any request.
  useEffect(() => {
    function onSignal(event: Event) {
      const code = (event as CustomEvent<SessionSignalCode>).detail;
      if (code === 'INACTIVE_USER') endInactive();
      // Only flips the flag: the change screen takes over, and it does no further request that could loop.
      else if (code === 'PASSWORD_CHANGE_REQUIRED') setUser((current) => (current && !current.mustChangePassword ? { ...current, mustChangePassword: true } : current));
    }
    window.addEventListener(SESSION_SIGNAL_EVENT, onSignal);
    return () => window.removeEventListener(SESSION_SIGNAL_EVENT, onSignal);
  }, [endInactive]);

  useEffect(() => {
    if (!initialToken) return;
    let cancelled = false;
    api
      .me(initialToken, () => undefined)
      .then(({ user: restored }) => {
        if (!cancelled) setUser(restored);
      })
      .catch((cause) => {
        if (cancelled) return;
        // Only a 401 proves the token is dead. Anything else (network, 5xx) is temporary: keep the
        // token, leave the user unset and let the operator retry instead of faking an expired session.
        if (cause instanceof ApiError && cause.code === 'INACTIVE_USER') {
          endInactive();
        } else if (cause instanceof ApiError && cause.status === 401) {
          storeToken(null);
          setToken(null);
          setUser(null);
        } else {
          setSessionError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialToken, attempt, endInactive]);

  const retrySession = useCallback(() => {
    setSessionError(false);
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setSessionMessage(null);
    storeToken(result.accessToken);
    setToken(result.accessToken);
    setUser(result.user);
  }, []);

  const adoptAccessToken = useCallback(async (accessToken: string) => {
    // The previous token is gone from this moment: storage first, then state; /auth/me with the NEW token is the source of truth.
    storeToken(accessToken);
    setToken(accessToken);
    const { user: refreshed } = await api.me(accessToken, logout);
    setUser(refreshed);
  }, [logout]);

  const value = useMemo(
    () => ({ token, user, loading, sessionError, retrySession, sessionMessage, adoptAccessToken, login, logout }),
    [token, user, loading, sessionError, retrySession, sessionMessage, adoptAccessToken, login, logout],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
