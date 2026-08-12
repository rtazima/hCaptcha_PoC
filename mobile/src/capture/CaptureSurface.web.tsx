/**
 * Área de arraste — versão web.
 *
 * Por que não reusar o `PanResponder` da versão nativa: verificado em Chromium
 * real, o `Pressable` funciona (os toques nos alvos registram) mas os eventos de
 * movimento do PanResponder não chegam de forma confiável no react-native-web —
 * quatro arrastes idênticos produziam um gesto ou nenhum. Aqui usamos Pointer
 * Events do DOM, que é o que o navegador entrega de verdade.
 *
 * `setPointerCapture` garante que o traço continue sendo entregue a este
 * elemento mesmo se o dedo sair da área, e `touch-action: none` impede o
 * navegador de transformar o arraste em rolagem da página.
 */
import React, { useCallback, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import type { StrokePoint } from '../api/contract';
import type { UseCaptureResult } from './useCapture';

export interface CaptureSurfaceProps {
  capture: UseCaptureResult;
  count: number;
  required: number;
}

export function CaptureSurface({ capture, count, required }: CaptureSurfaceProps) {
  const stroke = useRef<StrokePoint[]>([]);
  const active = useRef<number | null>(null);

  /** normaliza pela janela, igual ao nativo, para as features baterem */
  const point = useCallback(
    (event: { clientX: number; clientY: number }): StrokePoint => ({
      t: capture.now(),
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    }),
    [capture],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (active.current !== null) return;
      active.current = event.pointerId;
      stroke.current = [point(event)];
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [point],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (active.current !== event.pointerId) return;
      stroke.current.push(point(event));
    },
    [point],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (active.current !== event.pointerId) return;
      active.current = null;
      const collected = stroke.current;
      stroke.current = [];
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      capture.noteStroke(collected);
    },
    [capture],
  );

  return (
    // @ts-expect-error react-native-web repassa os handlers de ponteiro e
    // touchAction para o DOM; a tipagem do React Native não conhece nenhum dos dois
    <View
      testID="capture-swipe-area"
      style={[styles.area, { touchAction: 'none' }]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <Text style={styles.label}>
        {count >= required ? 'pode continuar arrastando' : 'arraste em qualquer direção'}
      </Text>
      <Text style={styles.count}>
        {count}/{required}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  area: {
    height: 150,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  label: { color: colors.textDim, fontSize: 13 },
  count: { color: colors.primary, fontSize: 22, fontWeight: '700' },
});
