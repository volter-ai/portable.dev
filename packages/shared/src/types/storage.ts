/**
 * Storage management types for workspace volume manager
 */

export interface StorageEntry {
  name: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: string; // ISO date string
}

export interface StorageListResponse {
  entries: StorageEntry[];
  totalSizeBytes: number;
  path: string;
}

export interface StorageUsageResponse {
  usedBytes: number;
  usedGB: number;
}

export interface StorageDeleteResponse {
  success: boolean;
  freedBytes: number;
}

export interface StorageBulkDeleteResponse {
  success: boolean;
  freedBytes: number;
  deleted: number;
  errors: string[];
}
