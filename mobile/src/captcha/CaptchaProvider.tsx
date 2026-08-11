/**
 * Integração com @hcaptcha/react-native-hcaptcha.
 *
 * O widget fica montado uma única vez na raiz do app e é exposto como uma
 * promise: `getToken()` chama `show()` e resolve com o token. Em modo passivo
 * (`passiveSiteKey`) nem modal aparece — é o caminho "invisible + passive" do
 * Enterprise, onde o sinal comportamental é colhido sem interromper ninguém.
 *
 * Protocolo do SDK (visto em Hcaptcha.js):
 *   event.success && data.length > 35  -> token
 *   data === 'open'                    -> desafio abriu
 *   event.success === false            -> erro / 'challenge-closed' / 'expired'
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';
import ConfirmHcaptcha from '@hcaptcha/react-native-hcaptcha';

/** Token + callback que impede o SDK de marcá-lo como expirado. */
export interface CaptchaToken {
  token: string;
  /** chame depois de enviar o token ao backend */
  markUsed: () => void;
}

export class CaptchaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CaptchaError';
  }
}

export type CaptchaMode = 'live' | 'test' | 'mock';

interface CaptchaContextValue {
  mode: CaptchaMode;
  sitekey: string | null;
  /** modo passivo: nenhum modal, nem por um instante */
  passive: boolean;
  setPassive: (value: boolean) => void;
  /** risco simulado usado quando mode === 'mock' */
  mockRisk: number;
  setMockRisk: (value: number) => void;
  busy: boolean;
  getToken: () => Promise<CaptchaToken>;
}

const CaptchaContext = createContext<CaptchaContextValue | null>(null);

const TOKEN_WAIT_MS = 90_000;

const ERROR_MESSAGES: Record<string, string> = {
  'challenge-closed': 'Você fechou o desafio do hCaptcha.',
  cancel: 'Verificação cancelada.',
  expired: 'O token do hCaptcha expirou antes do envio.',
  error: 'O hCaptcha falhou ao carregar ou renderizar.',
  'script-error': 'Não foi possível baixar o api.js do hCaptcha (rede/proxy).',
  'rate-limited': 'O hCaptcha limitou as tentativas; espere um pouco.',
  'invalid-data': 'Parâmetros inválidos enviados ao hCaptcha (confira rqdata).',
  timeout: 'O hCaptcha não respondeu no tempo esperado.',
};

export interface CaptchaProviderProps {
  mode: CaptchaMode;
  sitekey: string | null;
  rqdata?: string | null;
  children: ReactNode;
}

export function CaptchaProvider({ mode, sitekey, rqdata, children }: CaptchaProviderProps) {
  const captchaRef = useRef<ConfirmHcaptcha | null>(null);
  const pending = useRef<{
    resolve: (value: CaptchaToken) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [passive, setPassive] = useState(false);
  const [mockRisk, setMockRisk] = useState(0.1);

  const settle = useCallback(
    (action: (p: NonNullable<typeof pending.current>) => void) => {
      const current = pending.current;
      if (!current) return; // evento atrasado de uma tentativa já encerrada
      pending.current = null;
      clearTimeout(current.timer);
      setBusy(false);
      action(current);
    },
    [],
  );

  const onMessage = useCallback(
    (event: {
      nativeEvent?: { data?: string };
      success?: boolean;
      markUsed?: () => void;
      reset?: () => void;
    }) => {
      const data = event?.nativeEvent?.data;
      if (data === 'open') return; // desafio visível: segue esperando o usuário

      if (event?.success && typeof data === 'string' && data.length > 35) {
        const markUsed = event.markUsed;
        settle((p) => p.resolve({ token: data, markUsed: () => markUsed?.() }));
        captchaRef.current?.hide();
        return;
      }

      const code = typeof data === 'string' && data.length > 0 ? data : 'error';
      settle((p) =>
        p.reject(new CaptchaError(code, ERROR_MESSAGES[code] ?? `hCaptcha: ${code}`)),
      );
      captchaRef.current?.hide();
    },
    [settle],
  );

  const getToken = useCallback((): Promise<CaptchaToken> => {
    // em modo mock o backend aceita "mock:<risco>", sem widget nem rede
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
        captchaRef.current?.hide();
      }, TOKEN_WAIT_MS);
      pending.current = { resolve, reject, timer };
      setBusy(true);
      captchaRef.current?.show();
    });
  }, [mode, mockRisk, settle, sitekey]);

  const value = useMemo<CaptchaContextValue>(
    () => ({ mode, sitekey, passive, setPassive, mockRisk, setMockRisk, busy, getToken }),
    [busy, getToken, mockRisk, mode, passive, sitekey],
  );

  return (
    <CaptchaContext.Provider value={value}>
      {children}
      {mode !== 'mock' && sitekey ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <ConfirmHcaptcha
            ref={captchaRef}
            siteKey={sitekey}
            baseUrl="https://hcaptcha.com"
            size="invisible"
            passiveSiteKey={passive}
            languageCode="pt-BR"
            theme="dark"
            backgroundColor="#0B1020"
            showLoading
            userJourney
            verifyParams={rqdata ? { rqdata } : undefined}
            onMessage={onMessage}
          />
        </View>
      ) : null}
    </CaptchaContext.Provider>
  );
}

export function useCaptcha(): CaptchaContextValue {
  const context = useContext(CaptchaContext);
  if (!context) throw new Error('useCaptcha precisa estar dentro de <CaptchaProvider>');
  return context;
}
