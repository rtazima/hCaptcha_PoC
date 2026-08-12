/**
 * Carrega /healthz e /v1/config e mantém em contexto.
 *
 * O app não hardcoda sitekey nem limiares: quem manda é o backend. Isso evita
 * a classe de bug em que app e servidor discordam sobre a política vigente.
 *
 * /healthz vem primeiro porque é a única rota que fica aberta quando o backend
 * exige chave de API — é assim que o app consegue dizer "falta a chave" em vez
 * de mostrar um 401 cru vindo de /v1/config.
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
import {
  ApiError,
  api,
  getApiKey,
  getBaseUrl,
  setApiKey,
  setBaseUrl,
  type ServerConfig,
} from './api/client';

export interface ServerHealth {
  users: number;
  captchaMode: string;
  authRequired: boolean;
  encryptionAtRest: boolean;
}

interface ServerConfigContextValue {
  config: ServerConfig | null;
  health: ServerHealth | null;
  loading: boolean;
  error: string | null;
  baseUrl: string;
  apiKey: string;
  changeBaseUrl: (url: string) => void;
  changeApiKey: (key: string) => void;
  reload: () => void;
}

const ServerConfigContext = createContext<ServerConfigContextValue | null>(null);

export function ServerConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setLocalBaseUrl] = useState(getBaseUrl());
  const [apiKey, setLocalApiKey] = useState(getApiKey());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const healthResponse = await api.health();
        if (cancelled) return;
        setHealth({
          users: healthResponse.users,
          captchaMode: healthResponse.captchaMode,
          authRequired: Boolean(healthResponse.authRequired),
          encryptionAtRest: Boolean(healthResponse.encryptionAtRest),
        });

        if (healthResponse.authRequired && getApiKey().length === 0) {
          setConfig(null);
          setError(
            'Este backend exige chave de API. Informe a chave abaixo para continuar ' +
              '(o valor de API_KEYS configurado no servidor).',
          );
          return;
        }

        const configResponse = await api.config();
        if (cancelled) return;
        setConfig(configResponse);
      } catch (caught: unknown) {
        if (cancelled) return;
        setConfig(null);
        if (caught instanceof ApiError && caught.code === 'unauthorized') {
          setError('A chave de API foi recusada pelo backend. Confira o valor.');
        } else {
          setError(
            caught instanceof ApiError ? caught.message : `Falha inesperada: ${String(caught)}`,
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiKey, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const changeBaseUrl = useCallback((url: string) => {
    setBaseUrl(url);
    setLocalBaseUrl(getBaseUrl());
  }, []);

  const changeApiKey = useCallback((key: string) => {
    setApiKey(key);
    setLocalApiKey(getApiKey());
  }, []);

  const value = useMemo<ServerConfigContextValue>(
    () => ({
      config,
      health,
      loading,
      error,
      baseUrl,
      apiKey,
      changeBaseUrl,
      changeApiKey,
      reload,
    }),
    [apiKey, baseUrl, changeApiKey, changeBaseUrl, config, error, health, loading, reload],
  );

  return <ServerConfigContext.Provider value={value}>{children}</ServerConfigContext.Provider>;
}

export function useServerConfig(): ServerConfigContextValue {
  const context = useContext(ServerConfigContext);
  if (!context) throw new Error('useServerConfig precisa estar dentro de <ServerConfigProvider>');
  return context;
}
