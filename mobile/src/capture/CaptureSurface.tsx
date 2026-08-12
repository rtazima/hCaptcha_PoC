/**
 * Área de arraste — versão nativa (iOS/Android).
 *
 * Usa `PanResponder`, que é o mecanismo do React Native para disputar o gesto
 * com a ScrollView em volta: sem isso, o scroll rouba o movimento e o traço
 * nunca chega completo.
 *
 * A versão web está em `CaptureSurface.web.tsx` e usa Pointer Events do DOM
 * direto — na web o PanResponder não entrega os eventos de movimento de forma
 * confiável, o que foi verificado num navegador real: os toques (`Pressable`)
 * registravam e os arrastes, não.
 *
 * As duas versões só coletam pontos. A regra que decide se um traço é toque ou
 * arraste vive em `useCapture.noteStroke`, uma vez só.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import type { UseCaptureResult } from './useCapture';

export interface CaptureSurfaceProps {
  capture: UseCaptureResult;
  /** quantos gestos já foram capturados */
  count: number;
  required: number;
}

export function CaptureSurface({ capture, count, required }: CaptureSurfaceProps) {
  return (
    <View testID="capture-swipe-area" style={styles.area} {...capture.swipePanHandlers}>
      <Text style={styles.label}>
        {count >= required ? 'pode continuar arrastando' : 'arraste em qualquer direção'}
      </Text>
      <Text style={styles.count}>
        {count}/{required}
      </Text>
    </View>
  );
}

export const surfaceStyles = StyleSheet.create({
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

const styles = surfaceStyles;
