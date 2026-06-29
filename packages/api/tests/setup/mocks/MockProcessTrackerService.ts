/**
 * MockProcessTrackerService
 *
 * Mock implementation of ProcessTrackerService for testing.
 * Provides in-memory process tracking without actual process management.
 */

interface TrackedProcess {
  id: string;
  userId: string;
  repoPath: string;
  chatId?: string;
  command: string;
  description?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt?: number;
  outputFilePath?: string;
}

export class MockProcessTrackerService {
  private processes: TrackedProcess[] = [];

  /**
   * Add a tracked process
   */
  addProcess(process: TrackedProcess): void {
    this.processes.push(process);
  }

  /**
   * Get all processes (for testing)
   */
  getAllProcesses(): TrackedProcess[] {
    return this.processes;
  }

  /**
   * Update process status
   */
  updateProcessStatus(
    id: string,
    status: 'running' | 'completed' | 'failed'
  ): void {
    const process = this.processes.find((p) => p.id === id);
    if (process) {
      process.status = status;
      if (status !== 'running') {
        process.endedAt = Date.now();
      }
    }
  }

  /**
   * Get processes for a specific user and repo
   */
  getProcessesForRepo(userId: string, repoPath: string): TrackedProcess[] {
    return this.processes.filter(
      (p) => p.userId === userId && p.repoPath === repoPath
    );
  }

  /**
   * Clear all processes (for testing)
   */
  reset(): void {
    this.processes = [];
  }
}
