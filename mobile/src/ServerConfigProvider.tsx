/**
 * Carrega GET /v1/config e mantém em contexto.
 *
 * O app não hardcoda sitekey nem limiares: quem manda é o backend. Isso evita
 * a classe de bug em que app e servidor discordam sobre a política vigente.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, getBaseUrl, setBaseUrl, type ServerConfig } from './api/client';

interface ServerConfigContextValue {
  config: ServerConfig | null;
  loading: boolean;
  error: string | null;
  baseUrl: string;
  changeBaseUrl: (url: string) => void;
  reload: () => void;
}

const ServerConfigContext = createContext<ServerConfigContextValue | null>(null);

export function ServerConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setLocalBaseUrl] = useState(getBaseUrl());

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .config()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message =
          caught instanceof ApiError ? caught.message : `Falha inesperada: ${String(caught)}`;
        setError(message);
        setConfig(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload, baseUrl]);

  const changeBaseUrl = useCallback((url: string) => {
    setBaseUrl(url);
    setLocalBaseUrl(getBaseUrl());
  }, []);

  const value = useMemo<ServerConfigContextValue>(
    () => ({ config, loading, error, baseUrl, changeBaseUrl, reload }),
    [baseUrl, changeBaseUrl, config, error, loading, reload],
  );

  return <ServerConfigContext.Provider value={value}>{children}</ServerConfigContext.Provider>;
}

export function useServerConfig(): ServerConfigContextValue {
  const context = useContext(ServerConfigContext);
  if (!context) throw new Error('useServerConfig precisa estar dentro de <ServerConfigProvider>');
  return context;
}
