/**
 * Versão web do provider do hCaptcha.
 *
 * O Metro escolhe este arquivo em vez de `CaptchaProvider.tsx` quando a
 * plataforma é web, e as telas não mudam: a interface exportada é idêntica.
 *
 * Por que existe: o SDK React Native embrulha o widget num WebView, que não
 * existe na web. Aqui usamos o widget JS oficial (`js.hcaptcha.com/1/api.js`)
 * em modo `invisible`, com `render=explicit` para controlar quando executa.
 *
 * Consequência que vale registrar na demo: **na web não é o SDK React Native
 * sendo exercitado**, é a API JS. O sinal comportamental que o hCaptcha coleta e
 * o token que ele devolve são do mesmo serviço, mas o caminho é outro — o
 * `journey tracking` do SDK nativo, por exemplo, não existe aqui.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface CaptchaToken {
  token: string;
  markUsed: () => void;
}

export class CaptchaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaptchaError';
  }
}

export type CaptchaMode = 'live' | 'test' | 'mock';

interface CaptchaContextValue {
  mode: CaptchaMode;
  sitekey: string | null;
  passive: boolean;
  setPassive: (value: boolean) => void;
  mockRisk: number;
  setMockRisk: (value: number) => void;
  busy: boolean;
  getToken: () => Promise<CaptchaToken>;
}

const CaptchaContext = createContext<CaptchaContextValue | null>(null);

const SCRIPT_ID = 'hcaptcha-api-js';
const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit';
const TOKEN_WAIT_MS = 90_000;

const ERROR_MESSAGES: Record<string, string> = {
  'challenge-closed': 'Você fechou o desafio do hCaptcha.',
  'script-error': 'Não foi possível carregar o hCaptcha (rede, proxy ou bloqueador).',
  expired: 'O token do hCaptcha expirou antes do envio.',
  timeout: 'O hCaptcha não respondeu no tempo esperado.',
  error: 'O hCaptcha falhou ao renderizar.',
};

interface HCaptchaApi {
  render: (container: HTMLElement, config: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var hcaptcha: HCaptchaApi | undefined;
}

/** Carrega o api.js uma única vez, mesmo com múltiplas chamadas concorrentes. */
let scriptPromise: Promise<HCaptchaApi> | null = null;
function loadHcaptcha(): Promise<HCaptchaApi> {
  if (globalThis.hcaptcha) return Promise.resolve(globalThis.hcaptcha);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<HCaptchaApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const onReady = () => {
      // o api.js define window.hcaptcha de forma assíncrona ao próprio onload
      const start = Date.now();
      const poll = setInterval(() => {
        if (globalThis.hcaptcha) {
          clearInterval(poll);
          resolve(globalThis.hcaptcha);
        } else if (Date.now() - start > 15_000) {
          clearInterval(poll);
          reject(new CaptchaError('script-error', ERROR_MESSAGES['script-error']));
        }
      }, 100);
    };

    if (existing) {
      onReady();
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = onReady;
    script.onerror = () =>
      reject(new CaptchaError('script-error', ERROR_MESSAGES['script-error']));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface CaptchaProviderProps {
  mode: CaptchaMode;
  sitekey: string | null;
  rqdata?: string | null;
  children: ReactNode;
}

export function CaptchaProvider({ mode, sitekey, rqdata, children }: CaptchaProviderProps) {
  const widgetId = useRef<string | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const pending = useRef<{
    resolve: (value: CaptchaToken) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [passive, setPassive] = useState(false);
  const [mockRisk, setMockRisk] = useState(0.1);

  const settle = useCallback((action: (p: NonNullable<typeof pending.current>) => void) => {
    const current = pending.current;
    if (!current) return; // evento atrasado de uma tentativa já encerrada
    pending.current = null;
    clearTimeout(current.timer);
    setBusy(false);
    action(current);
  }, []);

  // o container fica fora da árvore do React: o widget invisível não desenha
  // nada, e assim não briga com o react-native-web por posicionamento
  useEffect(() => {
    if (mode === 'mock' || !sitekey) return;
    const div = document.createElement('div');
    div.id = 'hcaptcha-invisible-container';
    div.style.display = 'none';
    document.body.appendChild(div);
    container.current = div;

    let cancelled = false;
    loadHcaptcha()
      .then((api) => {
        if (cancelled || !container.current) return;
        widgetId.current = api.render(container.current, {
          sitekey,
          size: 'invisible',
          theme: 'dark',
          hl: 'pt-BR',
          callback: (token: string) => {
            settle((p) => p.resolve({ token, markUsed: () => {} }));
          },
          'error-callback': () => {
            settle((p) => p.reject(new CaptchaError('error', ERROR_MESSAGES.error)));
          },
          'expired-callback': () => {
            settle((p) => p.reject(new CaptchaError('expired', ERROR_MESSAGES.expired)));
          },
          'close-callback': () => {
            settle((p) =>
              p.reject(new CaptchaError('challenge-closed', ERROR_MESSAGES['challenge-closed'])),
            );
          },
          ...(rqdata ? { rqdata } : {}),
        });
      })
      .catch((error: unknown) => {
        // o erro reaparece em getToken(); aqui só registra
        console.warn('hCaptcha (web) não carregou:', error);
      });

    return () => {
      cancelled = true;
      container.current?.remove();
      container.current = null;
      widgetId.current = null;
    };
  }, [mode, rqdata, settle, sitekey]);

  const getToken = useCallback((): Promise<CaptchaToken> => {
    if (mode === 'mock') {
      return Promise.resolve({ token: `mock:${mockRisk}`, markUsed: () => {} });
    }
    if (!sitekey) {
      return Promise.reject(
        new CaptchaError('no_sitekey', 'Sitekey ainda não carregado do backend.'),
      );
    }
    if (pending.current) {
      return Promise.reject(
        new CaptchaError('busy', 'Já existe uma verificação do hCaptcha em andamento.'),
      );
    }

    return new Promise<CaptchaToken>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle((p) => p.reject(new CaptchaError('timeout', ERROR_MESSAGES.timeout)));
      }, TOKEN_WAIT_MS);
      pending.current = { resolve, reject, timer };
      setBusy(true);

      const api = globalThis.hcaptcha;
      if (!api || widgetId.current == null) {
        settle((p) => p.reject(new CaptchaError('script-error', ERROR_MESSAGES['script-error'])));
        return;
      }
      try {
        // reset antes de executar: sem isso, uma segunda chamada reaproveitaria
        // o token anterior, que o backend recusaria por replay em modo live
        api.reset(widgetId.current);
        api.execute(widgetId.current);
      } catch (error) {
        settle((p) => p.reject(new CaptchaError('error', String(error))));
      }
    });
  }, [mode, mockRisk, settle, sitekey]);

  const value = useMemo<CaptchaContextValue>(
    () => ({ mode, sitekey, passive, setPassive, mockRisk, setMockRisk, busy, getToken }),
    [busy, getToken, mockRisk, mode, passive, sitekey],
  );

  return <CaptchaContext.Provider value={value}>{children}</CaptchaContext.Provider>;
}

export function useCaptcha(): CaptchaContextValue {
  const context = useContext(CaptchaContext);
  if (!context) throw new Error('useCaptcha precisa estar dentro de <CaptchaProvider>');
  return context;
}
