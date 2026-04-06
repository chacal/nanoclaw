import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  chatJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((chatJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(chatJid: string): GroupState {
    let state = this.groups.get(chatJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(chatJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (chatJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(chatJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ chatJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(chatJid)) {
        this.waitingGroups.push(chatJid);
      }
      logger.debug(
        { chatJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(chatJid, 'messages').catch((err) =>
      logger.error({ chatJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(chatJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ chatJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ chatJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, chatJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(chatJid);
      }
      logger.debug({ chatJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, chatJid, fn });
      if (!this.waitingGroups.includes(chatJid)) {
        this.waitingGroups.push(chatJid);
      }
      logger.debug(
        { chatJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(chatJid, { id: taskId, chatJid, fn }).catch((err) =>
      logger.error({ chatJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    chatJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(chatJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(chatJid: string): void {
    const state = this.getGroup(chatJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(chatJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(chatJid: string, text: string): boolean {
    const state = this.getGroup(chatJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(chatJid: string): void {
    const state = this.getGroup(chatJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    chatJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(chatJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { chatJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(chatJid, state);
        }
      }
    } catch (err) {
      logger.error({ chatJid, err }, 'Error processing messages for group');
      this.scheduleRetry(chatJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(chatJid);
    }
  }

  private async runTask(chatJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(chatJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { chatJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ chatJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(chatJid);
    }
  }

  private scheduleRetry(chatJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { chatJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { chatJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatJid);
      }
    }, delayMs);
  }

  private drainGroup(chatJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(chatJid, task).catch((err) =>
        logger.error(
          { chatJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(chatJid, 'drain').catch((err) =>
        logger.error(
          { chatJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { chatJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { chatJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
