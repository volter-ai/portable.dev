import { KeyboardAvoidingView as RNKC_KAV } from 'react-native-keyboard-controller';
import { KeyboardAvoidingView as RN_KAV } from 'react-native';

// keyboard-controller's ForwardRefExoticComponent type triggers React 19's stricter
// ReactPortal.children constraint; RN's class-component type does not — same runtime props.
export const KeyboardAvoidingView = RNKC_KAV as unknown as typeof RN_KAV;
