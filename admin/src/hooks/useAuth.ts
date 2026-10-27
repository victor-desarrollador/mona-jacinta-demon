import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type UserContext } from '../lib/api';
import { readStoredToken, storeToken } from '../lib/auth';

type AuthContextValue = {
  token: string | null;
  user: UserContext | null;
  loading: boolean;
  // /auth/me could not be reached (network/5xx): the token is kept and the session is unknown, not expired.
  sessionError: boolean;
  retrySession: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initialToken] = useState(readStoredToken);
  const [token, setToken] = useState<string | null>(initialToken);
  const [user, setUser] = useState<UserContext | null>(null);
  // A stored token is only a candidate: the session is not restored until /auth/me accepts it.
  const [loading, setLoading] = useState(initialToken !== null);
  const [sessionError, setSessionError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const logout = useCallback(() => {
    storeToken(null);
    setToken(null);
    setUser(null);
  }, []);

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
        if (cause instanceof ApiError && cause.status === 401) {
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
  }, [initialToken, attempt]);

  const retrySession = useCallback(() => {
    setSessionError(false);
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    storeToken(result.accessToken);
    setToken(result.accessToken);
    setUser(result.user);
  }, []);

  const value = useMemo(
    () => ({ token, user, loading, sessionError, retrySession, login, logout }),
    [token, user, loading, sessionError, retrySession, login, logout],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
