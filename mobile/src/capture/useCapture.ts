/**
 * Hook que amarra o CaptureRecorder aos sensores e aos handlers de UI.
 *
 * Exporta os três coletores que as telas usam:
 *   - `typing`  -> props para o TextInput
 *   - `swipe`   -> PanResponder para a área de arraste
 *   - `tap`     -> handlers de pressionar/soltar dos alvos
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, PanResponder, type GestureResponderEvent } from 'react-native';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { CaptureRecorder, type CaptureCounts, classifyKey } from './recorder';
import type { DeviceInfo, StrokePoint } from '../api/contract';

const MOTION_INTERVAL_MS = 50; // 20 Hz
const COUNTS_REFRESH_MS = 250;
/** deslocamento abaixo disto (fração da tela) conta como toque, não arraste */
const TAP_THRESHOLD = 0.02;

export interface UseCaptureResult {
  recorder: CaptureRecorder;
  counts: CaptureCounts;
  /** props prontas para o TextInput de digitação */
  typing: {
    onKeyPress: (event: { nativeEvent: { key: string } }) => void;
    onChangeText: (text: string) => void;
    value: string;
    reset: () => void;
  };
  /** handlers do PanResponder da área de arraste (usado na superfície nativa) */
  swipePanHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
  /**
   * Classifica um traço já coletado como toque ou arraste e registra.
   * As superfícies de captura (nativa e web) só coletam pontos; a regra de
   * classificação fica aqui, uma vez só.
   */
  noteStroke: (points: StrokePoint[]) => void;
  /** relógio do recorder, em ms desde o início da captura */
  now: () => number;
  /** handlers dos alvos de toque */
  tap: {
    onPressIn: (event: GestureResponderEvent) => void;
    onPressOut: () => void;
  };
  device: DeviceInfo;
  restart: () => void;
  motionAvailable: boolean;
  /**
   * No Safari do iOS os sensores só ligam depois de `requestPermission()`
   * chamado a partir de um gesto do usuário. Em nativo é no-op.
   */
  requestMotionPermission: (() => Promise<void>) | null;
}

export function useCapture(): UseCaptureResult {
  const recorderRef = useRef(new CaptureRecorder());
  const recorder = recorderRef.current;

  const [counts, setCounts] = useState<CaptureCounts>(() => recorder.counts());
  const [text, setText] = useState('');
  const [motionAvailable, setMotionAvailable] = useState(true);

  // ---- sensores ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const gyro = { gx: 0, gy: 0, gz: 0 };
    const subscriptions: Array<{ remove: () => void }> = [];

    (async () => {
      const [accelOk, gyroOk] = await Promise.all([
        Accelerometer.isAvailableAsync().catch(() => false),
        Gyroscope.isAvailableAsync().catch(() => false),
      ]);
      if (cancelled) return;
      if (!accelOk) {
        setMotionAvailable(false);
        return;
      }

      // `isAvailableAsync` pode dizer que sim e `addListener` ainda estourar: no
      // navegador o módulo web do expo-sensors não implementa os dois. Sem este
      // try/catch o app cospe um erro de JS e a demo ganha cara de quebrada,
      // ainda que a captura siga funcionando sem o grupo de movimento.
      try {
        Accelerometer.setUpdateInterval(MOTION_INTERVAL_MS);
        if (gyroOk) {
          Gyroscope.setUpdateInterval(MOTION_INTERVAL_MS);
          subscriptions.push(
            Gyroscope.addListener(({ x, y, z }) => {
              gyro.gx = x;
              gyro.gy = y;
              gyro.gz = z;
            }),
          );
        }
        // o acelerômetro é o relógio: cada leitura dele emite uma amostra
        // combinada com o último valor conhecido do giroscópio
        subscriptions.push(
          Accelerometer.addListener(({ x, y, z }) => {
            recorder.noteMotion({ ax: x, ay: y, az: z, ...gyro });
          }),
        );
      } catch (error) {
        console.warn('sensores de movimento indisponíveis:', error);
        setMotionAvailable(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [recorder]);

  // ---- atualização periódica do painel de progresso ----------------------
  useEffect(() => {
    const timer = setInterval(() => setCounts(recorder.counts()), COUNTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [recorder]);

  const refresh = useCallback(() => setCounts(recorder.counts()), [recorder]);

  // ---- digitação ---------------------------------------------------------
  const previousText = useRef('');

  const onKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      recorder.noteKeystroke(classifyKey(event.nativeEvent.key));
      refresh();
    },
    [recorder, refresh],
  );

  /**
   * Rede de segurança: em vários teclados de software do Android o onKeyPress
   * não dispara para todas as teclas. Aqui comparamos o tamanho do texto e, se
   * o onKeyPress não registrou nada desde a última mudança, registramos a
   * diferença. Sem isso a captura de digitação simplesmente não acontece em
   * parte dos aparelhos.
   */
  const onChangeText = useCallback(
    (next: string) => {
      const before = previousText.current;
      previousText.current = next;
      setText(next);

      const delta = next.length - before.length;
      const registeredByKeyPress = recorder.counts().keystrokes > lastKeyCount.current;
      lastKeyCount.current = recorder.counts().keystrokes;
      if (registeredByKeyPress) {
        refresh();
        return;
      }

      if (delta > 1) {
        // colagem ou autocompletar: marca e registra um único evento, porque o
        // intervalo entre essas teclas não reflete o ritmo da pessoa
        recorder.notePaste();
        recorder.noteKeystroke('char');
      } else if (delta === 1) {
        recorder.noteKeystroke(next.endsWith(' ') ? 'space' : 'char');
      } else if (delta < 0) {
        recorder.noteKeystroke('backspace');
      }
      refresh();
    },
    [recorder, refresh],
  );

  const lastKeyCount = useRef(0);

  const resetTyping = useCallback(() => {
    previousText.current = '';
    lastKeyCount.current = recorder.counts().keystrokes;
    setText('');
  }, [recorder]);

  // ---- arraste -----------------------------------------------------------
  const noteStroke = useCallback(
    (stroke: StrokePoint[]) => {
      if (stroke.length < 3) return;
      const first = stroke[0];
      const last = stroke[stroke.length - 1];
      const travelled = Math.hypot(last.x - first.x, last.y - first.y);
      if (travelled < TAP_THRESHOLD) {
        // dedo encostou e saiu: é toque, não arraste
        recorder.noteTap(first.x, first.y, last.t - first.t, first.t);
      } else {
        recorder.noteGesture(stroke);
      }
      refresh();
    },
    [recorder, refresh],
  );

  const now = useCallback(() => recorder.now(), [recorder]);

  const strokeRef = useRef<StrokePoint[]>([]);
  const swipePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          strokeRef.current = [pointOf(event, recorder.now())];
        },
        onPanResponderMove: (event) => {
          strokeRef.current.push(pointOf(event, recorder.now()));
        },
        onPanResponderRelease: () => {
          const stroke = strokeRef.current;
          strokeRef.current = [];
          noteStroke(stroke);
        },
        onPanResponderTerminate: () => {
          strokeRef.current = [];
        },
      }),
    [noteStroke, recorder],
  );

  // ---- toques ------------------------------------------------------------
  const pressRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const onPressIn = useCallback(
    (event: GestureResponderEvent) => {
      const point = pointOf(event, recorder.now());
      pressRef.current = { t: point.t, x: point.x, y: point.y };
    },
    [recorder],
  );
  const onPressOut = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    recorder.noteTap(press.x, press.y, recorder.now() - press.t, press.t);
    refresh();
  }, [recorder, refresh]);

  // ---- misc --------------------------------------------------------------
  const device = useMemo<DeviceInfo>(() => {
    const { width, height } = Dimensions.get('window');
    return {
      os: Platform.OS,
      osVersion: String(Device.osVersion ?? Platform.Version ?? ''),
      model: Device.modelName ?? 'desconhecido',
      screenDiagonal: Number(Math.hypot(width, height).toFixed(1)),
    };
  }, []);

  const restart = useCallback(() => {
    recorder.reset();
    resetTyping();
    setCounts(recorder.counts());
  }, [recorder, resetTyping]);

  /**
   * Só existe na web/iOS: a API DeviceMotionEvent exige consentimento vindo de
   * um gesto. Devolve null onde não se aplica, para a UI não mostrar um botão
   * inútil.
   */
  const requestMotionPermission = useMemo(() => {
    const DME = (globalThis as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } })
      .DeviceMotionEvent;
    if (typeof DME?.requestPermission !== 'function') return null;
    return async () => {
      try {
        const result = await DME.requestPermission!();
        setMotionAvailable(result === 'granted');
      } catch {
        setMotionAvailable(false);
      }
    };
  }, []);

  return {
    recorder,
    counts,
    typing: { onKeyPress, onChangeText, value: text, reset: resetTyping },
    swipePanHandlers: swipePanResponder.panHandlers,
    noteStroke,
    now,
    tap: { onPressIn, onPressOut },
    device,
    restart,
    motionAvailable,
    requestMotionPermission,
  };
}

function pointOf(event: GestureResponderEvent, t: number): StrokePoint {
  const { width, height } = Dimensions.get('window');
  const { pageX, pageY } = event.nativeEvent;
  return { t, x: pageX / width, y: pageY / height };
}
