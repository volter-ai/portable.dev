/**
 * Legal documents screen (`/settings/legal?doc=tos|privacy`) — renders the
 * ToS / privacy markdown inline. Linked from the settings root footer.
 */

import { MarkdownText } from '../../chat/blocks/MarkdownText';
import { SettingsSectionScreen } from '../chrome';
import { PRIVACY_POLICY_MD } from './privacyPolicy';
import { TERMS_OF_SERVICE_MD } from './termsOfService';

export type LegalDoc = 'tos' | 'privacy';

export interface LegalScreenProps {
  doc: LegalDoc;
  onBack?: () => void;
}

const DOCS: Record<LegalDoc, { title: string; content: string }> = {
  tos: { title: 'Terms of Service', content: TERMS_OF_SERVICE_MD },
  privacy: { title: 'Privacy Policy', content: PRIVACY_POLICY_MD },
};

export function LegalScreen({ doc, onBack }: LegalScreenProps) {
  const { title, content } = DOCS[doc] ?? DOCS.tos;
  return (
    <SettingsSectionScreen title={title} testID={`settings-legal-${doc}`} onBack={onBack}>
      <MarkdownText content={content} testID={`settings-legal-${doc}-content`} />
    </SettingsSectionScreen>
  );
}
