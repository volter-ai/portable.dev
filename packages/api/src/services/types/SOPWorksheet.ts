/**
 * SOP load result
 */
export interface SOPLoadResult {
  source: 'repo' | 'default';  // Where SOP came from
  content: string;             // SOP markdown content
  filePath?: string;           // Path to .volter/sop.md (only if source === 'repo')
}
