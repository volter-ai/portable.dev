/**
 * NewProjectCard — the synthetic "＋ New" tile injected at the front of the home
 * Linked-Projects grid. Same footprint as a {@link RepoCard} (a 60px rounded tile +
 * a label beneath), but with a dashed primary-colored border + a plus glyph. Press →
 * create a new Portable project (a local folder + a bootstrapped GitHub repo).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { repoNameFontSize } from './homeHelpers';
import { Icon, useAppTheme } from '../../theme';

export function NewProjectCard({ onPress }: { onPress: () => void }) {
  const { theme } = useAppTheme();
  // Size the "New" label exactly like a short repo name so it lines up with siblings.
  const nameSize = repoNameFontSize('New'.length);

  return (
    <Pressable
      testID="home-new-project"
      accessibilityRole="button"
      accessibilityLabel="New project"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.iconFrame}>
        <View
          style={[
            styles.tile,
            { borderColor: theme.colors.primary, backgroundColor: theme.colors.surface },
          ]}
        >
          <Icon name="plus" size={26} color={theme.colors.primary} strokeWidth={2.4} />
        </View>
      </View>

      <Text
        numberOfLines={2}
        style={[
          styles.name,
          {
            color: theme.colors.text,
            fontSize: nameSize,
            lineHeight: Math.round(nameSize * 1.15),
            minHeight: Math.round(nameSize * 1.8),
          },
        ]}
      >
        New
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Mirrors RepoCard so the tile sits flush in the grid.
  card: { alignItems: 'center', gap: 6, paddingVertical: 2 },
  cardPressed: { transform: [{ scale: 0.95 }] },
  iconFrame: { width: '100%', maxWidth: 60 },
  tile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    textAlign: 'center',
    fontWeight: '700',
    letterSpacing: -0.1,
    paddingHorizontal: 2,
  },
});
