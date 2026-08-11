/**
 * Junta captura + sessão do servidor + token do hCaptcha num fluxo só.
 *
 * A sessão de captura é criada quando a captura começa (não na hora do envio):
 * é ela que amarra "estes eventos" a "esta janela de tempo" no servidor, e o
 * backend a consome uma única vez. Um snapshot reenviado é recusado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { RawSample, SessionInitResponse } from '../api/contract';
import { useCaptcha, type CaptchaToken } from '../captcha/CaptchaProvider';
import { describeError } from '../strings';
import { useCapture, type UseCaptureResult } from './useCapture';

export interface CaptureFlow {
  capture: UseCaptureResult;
  session: SessionInitResponse | null;
  /** captura pronta para envio (mínimos atingidos e sessão obtida) */
  ready: boolean;
  sessionError: string | null;
  restart: () => void;
  /** monta o payload; lança se a sessão ainda não chegou */
  buildSample: (task: string) => RawSample;
  requestToken: () => Promise<CaptchaToken>;
}

export function useCaptureFlow(taskLabel: string): CaptureFlow {
  const capture = useCapture();
  const captcha = useCaptcha();
  const [session, setSession] = useState<SessionInitResponse | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const generation = useRef(0);

  const openSession = useCallback(() => {
    const current = ++generation.current;
    setSession(null);
    setSessionError(null);
    api
      .initSession()
      .then((value) => {
        if (generation.current === current) setSession(value);
      })
      .catch((caught: unknown) => {
        if (generation.current !== current) return;
        setSessionError(
          caught instanceof ApiError
            ? describeError(caught.code, caught.message)
            : `Falha ao abrir a sessão de captura: ${String(caught)}`,
        );
      });
  }, []);

  useEffect(() => {
    openSession();
    capture.recorder.noteScreen(taskLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = useCallback(() => {
    capture.restart();
    capture.recorder.noteScreen(taskLabel);
    openSession();
  }, [capture, openSession, taskLabel]);

  const buildSample = useCallback(
    (task: string): RawSample => {
      if (!session) throw new Error('sessão de captura ainda não foi criada');
      return capture.recorder.snapshot(session.sessionId, task, capture.device);
    },
    [capture.device, capture.recorder, session],
  );

  return {
    capture,
    session,
    ready: session != null && capture.recorder.isComplete(),
    sessionError,
    restart,
    buildSample,
    requestToken: captcha.getToken,
  };
}
