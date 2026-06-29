/**
 * Upload a picked file to `POST /api/upload`.
 *
 * Mirrors the voice `transcribeRecording` multipart pattern: the `file` part is
 * appended via {@link appendFormDataFile} — the winter-fetch-compatible file part
 * (the classic RN `{uri,name,type}` part throws `Unsupported FormDataPart
 * implementation` under Expo SDK 56's global fetch). The authed sandbox client
 * adds the Bearer header + boundary; we set no Content-Type. The multer field
 * name is `file` (`repository.routes.ts` `.single('file')`).
 */

import { appendFormDataFile } from '../../api/formDataFile';
import type { UploadFileResponse } from '../../api/hooks';
import type { RelayApiClient } from '../../api/relayClient';
import type { PickedFile } from './attachment';

export async function uploadAttachment(
  api: RelayApiClient,
  file: PickedFile
): Promise<UploadFileResponse> {
  const form = new FormData();
  appendFormDataFile(form, 'file', file);

  const data = await api.upload<UploadFileResponse>('/api/upload', form);
  if (!data?.path) {
    throw new Error('Upload failed: no path returned');
  }
  return data;
}
