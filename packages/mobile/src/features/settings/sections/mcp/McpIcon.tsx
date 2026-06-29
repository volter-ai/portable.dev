/**
 * Native `McpIcon`.
 *
 * Render strategy comes from {@link resolveMcpIconSource}: emoji glyph as `Text`
 * (no Fluent CDN on RN) → custom
 * URL / website favicon via RN `Image` → colored 6px-radius box with the
 * uppercased first letter (bg `colorTheme || theme.colors.surfaceHover`,
 * white letter at `size / 2` / 600).
 *
 * testIDs (suffixed onto the `testID` prop): `-emoji` | `-image` | `-fallback`.
 */

import { Image, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../../theme';
import { resolveMcpIconSource, type McpIconData } from './mcpHelpers';

export interface McpIconProps {
  mcp: McpIconData;
  /** Icon size in px (default 32). */
  size?: number;
  testID?: string;
}

export function McpIcon({ mcp, size = 32, testID }: McpIconProps) {
  const { theme } = useAppTheme();
  const source = resolveMcpIconSource(mcp);
  const box = { width: size, height: size };

  if (source.kind === 'emoji') {
    return (
      <View style={[styles.box, box]} testID={testID}>
        <Text
          testID={testID ? `${testID}-emoji` : undefined}
          style={{ fontSize: size * 0.75, lineHeight: size }}
          allowFontScaling={false}
        >
          {source.emoji}
        </Text>
      </View>
    );
  }

  if (source.kind === 'image') {
    return (
      <View style={[styles.box, box]} testID={testID}>
        <Image
          testID={testID ? `${testID}-image` : undefined}
          source={{ uri: source.uri }}
          style={[box, styles.image]}
          resizeMode="contain"
          accessibilityLabel={`${mcp.name} icon`}
        />
      </View>
    );
  }

  return (
    <View
      testID={testID}
      style={[
        styles.box,
        styles.fallback,
        box,
        { backgroundColor: mcp.colorTheme || theme.colors.surfaceHover },
      ]}
    >
      <Text
        testID={testID ? `${testID}-fallback` : undefined}
        style={[styles.fallbackLetter, { fontSize: size / 2 }]}
        allowFontScaling={false}
      >
        {source.letter}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  image: { borderRadius: 6 },
  fallback: { borderRadius: 6 },
  // Fallback letter is literal #fff regardless of theme — keep it.
  fallbackLetter: { color: '#fff', fontWeight: '600' },
});
