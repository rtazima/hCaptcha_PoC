/** Componentes visuais reaproveitados pelas telas. */
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, radius, spacing } from '../theme';

export function Card({
  title,
  subtitle,
  children,
  style,
}: {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.card, style]}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  loading,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Text style={[styles.buttonLabel, variant === 'ghost' && styles.buttonLabelGhost]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'none',
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences';
  keyboardType?: 'default' | 'url';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
      />
    </View>
  );
}

export function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

/** Barra 0..1 com marcador de limiar. */
export function Meter({
  value,
  threshold,
  color,
}: {
  value: number;
  threshold?: number;
  color: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <View style={styles.meterTrack}>
      <View style={[styles.meterFill, { width: `${clamped * 100}%`, backgroundColor: color }]} />
      {threshold != null ? (
        <View
          style={[styles.meterThreshold, { left: `${Math.min(100, Math.max(0, threshold * 100))}%` }]}
        />
      ) : null}
    </View>
  );
}

export function Checklist({
  items,
}: {
  items: Array<{ label: string; done: boolean; detail?: string }>;
}) {
  return (
    <View style={styles.checklist}>
      {items.map((item) => (
        <View key={item.label} style={styles.checkItem}>
          <Text style={[styles.checkMark, { color: item.done ? colors.allow : colors.textDim }]}>
            {item.done ? '●' : '○'}
          </Text>
          <Text style={styles.checkLabel}>{item.label}</Text>
          {item.detail ? <Text style={styles.checkDetail}>{item.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function Notice({ text, tone = colors.stepUp }: { text: string; tone?: string }) {
  return (
    <View style={[styles.notice, { borderLeftColor: tone }]}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

export const textStyles: Record<string, StyleProp<TextStyle>> = {
  h1: { color: colors.text, fontSize: 24, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  dim: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  mono: { color: colors.textDim, fontSize: 12, fontFamily: 'monospace' },
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: spacing.xs },
  cardSubtitle: { color: colors.textDim, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.deny },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  buttonLabelGhost: { color: colors.text },
  field: { marginBottom: spacing.md },
  fieldLabel: { color: colors.textDim, fontSize: 13, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 5,
    gap: spacing.md,
  },
  rowLabel: { color: colors.textDim, fontSize: 13, flexShrink: 0 },
  rowValue: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  meterTrack: {
    height: 10,
    backgroundColor: colors.cardAlt,
    borderRadius: 999,
    overflow: 'hidden',
    marginVertical: spacing.sm,
    position: 'relative',
  },
  meterFill: { height: '100%', borderRadius: 999 },
  meterThreshold: {
    position: 'absolute',
    top: -3,
    width: 2,
    height: 16,
    backgroundColor: colors.text,
  },
  checklist: { gap: 6, marginTop: spacing.sm },
  checkItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkMark: { fontSize: 14 },
  checkLabel: { color: colors.text, fontSize: 14, flex: 1 },
  checkDetail: { color: colors.textDim, fontSize: 12 },
  notice: {
    backgroundColor: colors.cardAlt,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  noticeText: { color: colors.text, fontSize: 13, lineHeight: 19 },
});
