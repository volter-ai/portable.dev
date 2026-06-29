/**
 * Native avatar picker — the ONLY module importing
 * `expo-image-picker` for the profile-photo flow (mirrors how `expoPickers.ts`
 * isolates the picker for chat attachments). Keeping the native import here lets
 * the settings ViewModel + its tests stay native-module-free via an injectable
 * `pickAvatar` seam.
 *
 * Picks a single square image from the device photo library and returns it as a
 * base64 `data:` URI — the form Clerk's `user.setProfileImage({ file })` accepts
 * on React Native. Returns `null` when permission is denied or the user cancels.
 */

import * as ImagePicker from 'expo-image-picker';

export async function pickAvatarImage(): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.85,
    base64: true,
  });
  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];
  // Prefer a base64 data URI (what Clerk accepts on RN); fall back to the file URI.
  if (asset.base64) {
    const mime = asset.mimeType ?? 'image/jpeg';
    return `data:${mime};base64,${asset.base64}`;
  }
  return asset.uri;
}
