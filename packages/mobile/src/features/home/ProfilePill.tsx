/**
 * ProfilePill — the floating glassmorphic profile pill in the home's top-right
 * corner. A hamburger (`bars`) glyph + a 28px
 * circular avatar (image when available, else the user's initial, else a user
 * glyph). Press → the Settings hub.
 */

import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { Icon, useAppTheme, withAlpha } from '../../theme';

export interface ProfilePillProps {
  /** Avatar image URL (from `GET /api/user`), if any. */
  avatarUrl?: string | null;
  onPress: () => void;
}

export function ProfilePill({ avatarUrl, onPress }: ProfilePillProps) {
  const { theme } = useAppTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = !!avatarUrl && !imageFailed;

  return (
    <Pressable
      testID="home-profile-pill"
      accessibilityRole="button"
      accessibilityLabel="Open profile and settings"
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: withAlpha(theme.colors.surface, pressed ? '99' : '66'),
          borderColor: withAlpha(theme.colors.border, '40'),
        },
      ]}
    >
      <Icon name="bars" size={16} color={theme.colors.text} />
      {showImage ? (
        <Image
          testID="home-profile-avatar"
          source={{ uri: avatarUrl! }}
          onError={() => setImageFailed(true)}
          style={[styles.avatar, { borderColor: theme.colors.border }]}
        />
      ) : (
        // The no-avatar fallback is a bare user glyph (no circle).
        <View testID="home-profile-fallback" style={styles.fallback}>
          <Icon name="user" size={20} color={theme.colors.text} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingLeft: 8,
    borderWidth: 1,
    borderRadius: 24,
    alignSelf: 'flex-end',
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  fallback: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
