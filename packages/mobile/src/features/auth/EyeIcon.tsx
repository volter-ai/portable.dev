/**
 * Password show/hide eye glyph. `react-native-svg` so it renders crisply at 20x20.
 */

import Svg, { Path } from 'react-native-svg';

import { SIGN_IN_COLORS } from './signInTheme';

export function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    // Eye-slash (password currently visible → tap hides it).
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
        <Path
          d="M3.26 11.602A9.212 9.212 0 0 1 3 10c.692-2.665 3.153-5.5 7-5.5 1.194 0 2.267.273 3.202.737l-1.46 1.46A3.5 3.5 0 0 0 6.697 11.74l-1.46 1.46a8.652 8.652 0 0 1-1.977-1.598ZM7.818 4.818 6.364 3.364a9.212 9.212 0 0 1 2.836-.825C5.618 1.96 2.954 4.4 2 7.5a10.656 10.656 0 0 0 2.766 4.266l1.416-1.416a8.703 8.703 0 0 1-.99-1.849 8.703 8.703 0 0 1 2.626-6.683Zm4.364 4.364 1.414 1.414a3.5 3.5 0 0 0-4.192-4.192l1.414 1.414a1.5 1.5 0 0 1 1.364 1.364ZM17 10a8.96 8.96 0 0 1-.74 3.26l1.461 1.461A9.212 9.212 0 0 0 18 10c-.692-2.665-3.153-5.5-7-5.5-.658 0-1.287.08-1.882.218l1.719 1.719C13.806 6.693 16.197 8.087 17 10ZM2.293 2.293l1.414 1.414L15.293 15.293l1.414 1.414L18.414 15l-2.982-2.982A9.148 9.148 0 0 1 10 13.5c-3.847 0-6.308-2.835-7-5.5a10.668 10.668 0 0 1 2.766-4.266L3.707 1.707 2.293 2.293Z"
          fill={SIGN_IN_COLORS.inputIcon}
        />
      </Svg>
    );
  }
  // Eye (password currently hidden → tap reveals it).
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path
        d="M10 4.5C5.75 4.5 2.29 7.335 1.6 10c.69 2.665 4.15 5.5 8.4 5.5s7.71-2.835 8.4-5.5c-.69-2.665-4.15-5.5-8.4-5.5ZM10 13.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm0-5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
        fill={SIGN_IN_COLORS.inputIcon}
      />
    </Svg>
  );
}
