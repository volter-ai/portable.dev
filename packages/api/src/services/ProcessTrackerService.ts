/**
 * ProcessTrackerService - Tracks background bash processes globally
 * Processes are not locked to a specific chat/user, they run on the server
 */

interface BackgroundProcess {
  id: string // bash_id from Claude SDK
  command: string
  description?: string
  startedAt: number
  userId: string
  chatId: string
  repoPath?: string // Repository path (e.g., "owner/repo") that created this process
  status: 'running' | 'completed' | 'failed'
  isRefreshing?: boolean // True when BashOutput is being fetched
  lastOutputUpdate?: number // Timestamp of last BashOutput refresh
  outputFilePath?: string // Path to the output file (e.g., /tmp/claude/.../tasks/{id}.output)
}

interface BashOutputCache {
  status: string
  exitCode?: number
  stdout: string
  stderr: string
  summary?: string
  lastUpdated: number
}

export class ProcessTrackerService {
  private processes: Map<string, BackgroundProcess> = new Map()
  private outputCache: Map<string, BashOutputCache> = new Map()
  private statusChangeCallback?: (process: BackgroundProcess) => void

  /**
   * Set callback for status changes
   */
  setStatusChangeCallback(callback: (process: BackgroundProcess) => void): void {
    this.statusChangeCallback = callback
  }

  /**
   * Add a new background process
   */
  addProcess(
    id: string,
    command: string,
    description: string | undefined,
    userId: string,
    chatId: string,
    repoPath?: string,
    outputFilePath?: string
  ): void {
    this.processes.set(id, {
      id,
      command,
      description,
      startedAt: Date.now(),
      userId,
      chatId,
      repoPath,
      status: 'running',
      outputFilePath,
    })
    console.log(`[ProcessTracker] Added process ${id}: ${description || command}`)
  }

  /**
   * Update process status
   */
  updateProcessStatus(id: string, status: 'running' | 'completed' | 'failed'): void {
    const process = this.processes.get(id)
    if (process) {
      process.status = status
      console.log(`[ProcessTracker] Process ${id} status: ${status}`)

      // Notify callback if status changed to completed/failed
      if (status !== 'running' && this.statusChangeCallback) {
        this.statusChangeCallback(process)
      }

      // Auto-remove completed/failed processes after 5 minutes (keep for display)
      if (status !== 'running') {
        setTimeout(() => {
          this.processes.delete(id)
          console.log(`[ProcessTracker] Removed process ${id}`)
        }, 300000) // 5 minutes
      }
    }
  }

  /**
   * Get all running processes
   */
  getAllProcesses(): BackgroundProcess[] {
    return Array.from(this.processes.values())
  }

  /**
   * Get running processes only
   */
  getRunningProcesses(): BackgroundProcess[] {
    return Array.from(this.processes.values()).filter(p => p.status === 'running')
  }

  /**
   * Get the 10 most recent processes (reverse chronological order)
   */
  getRecentProcesses(limit: number = 10): BackgroundProcess[] {
    return Array.from(this.processes.values())
      .sort((a, b) => b.startedAt - a.startedAt) // Reverse chronological
      .slice(0, limit)
  }

  /**
   * Remove a process (e.g., when killed)
   */
  removeProcess(id: string): void {
    this.processes.delete(id)
    console.log(`[ProcessTracker] Removed process ${id}`)
  }

  /**
   * Clear all processes (e.g., on server restart)
   */
  clearAll(): void {
    this.processes.clear()
    this.outputCache.clear()
    console.log(`[ProcessTracker] Cleared all processes and cache`)
  }

  /**
   * Cache BashOutput result
   */
  cacheOutput(
    bashId: string,
    status: string,
    stdout: string,
    stderr: string,
    exitCode?: number,
    summary?: string
  ): void {
    const lastUpdated = Date.now()

    this.outputCache.set(bashId, {
      status,
      exitCode,
      stdout,
      stderr,
      summary,
      lastUpdated
    })
    console.log(`[ProcessTracker] Cached output for ${bashId}: ${status}`)

    // Update process with lastOutputUpdate timestamp
    const process = this.processes.get(bashId)
    if (process) {
      process.lastOutputUpdate = lastUpdated
      console.log(`[ProcessTracker] Updated lastOutputUpdate for ${bashId}: ${lastUpdated}`)
    }

    // Update process status if we have it
    if (status === 'completed' || status === 'failed') {
      this.updateProcessStatus(bashId, status as 'completed' | 'failed')
    }
  }

  /**
   * Get cached BashOutput result
   */
  getCachedOutput(bashId: string): BashOutputCache | undefined {
    return this.outputCache.get(bashId)
  }

  /**
   * Check if we have cached output for a bash ID
   */
  hasCachedOutput(bashId: string): boolean {
    return this.outputCache.has(bashId)
  }

  /**
   * Clear cached output for a specific process
   */
  clearCachedOutput(bashId: string): void {
    this.outputCache.delete(bashId)
    console.log(`[ProcessTracker] Cleared cache for ${bashId}`)
  }

  /**
   * Get the chatId that owns a bash process
   * Used to route BashOutput requests to the correct session
   */
  getChatIdForBashId(bashId: string): string | undefined {
    const process = this.processes.get(bashId)
    return process?.chatId
  }

  /**
   * Set process as refreshing (fetching new output)
   */
  setRefreshing(bashId: string, isRefreshing: boolean): void {
    const process = this.processes.get(bashId)
    if (process) {
      process.isRefreshing = isRefreshing
      console.log(`[ProcessTracker] Process ${bashId} refreshing: ${isRefreshing}`)
    }
  }
}
