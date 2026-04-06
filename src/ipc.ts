import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

/**
 * Validate a schedule type/value and compute the next run time.
 * Returns null if validation fails (caller should log and abort).
 */
function parseSchedule(
  scheduleType: string,
  scheduleValue: string,
): { nextRun: string | null } | null {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return { nextRun: interval.next().toISOString() };
    } catch {
      logger.warn({ scheduleValue }, 'Invalid cron expression');
      return null;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue }, 'Invalid interval');
      return null;
    }
    return { nextRun: new Date(Date.now() + ms).toISOString() };
  } else if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue }, 'Invalid timestamp');
      return null;
    }
    return { nextRun: date.toISOString() };
  }
  return { nextRun: null };
}

/**
 * Look up a task, verify authorization, and execute an action on it.
 * Logs a warning if the task is not found or unauthorized.
 */
function withTaskAuth(
  taskId: string | undefined,
  sourceFolder: string,
  isMain: boolean,
  operationName: string,
  action: (task: NonNullable<ReturnType<typeof getTaskById>>) => void,
): void {
  if (!taskId) return;
  const task = getTaskById(taskId);
  if (task && (isMain || task.group_folder === sourceFolder)) {
    action(task);
  } else {
    logger.warn(
      { taskId, sourceFolder },
      `Unauthorized task ${operationName} attempt`,
    );
  }
}

/**
 * Process a single parsed IPC message: authorize and send via the appropriate channel.
 */
async function processMessageIpc(
  data: any,
  sourceFolder: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: Pick<IpcDeps, 'sendMessage'>,
): Promise<void> {
  if (
    data.type !== 'message' ||
    typeof data.chatJid !== 'string' ||
    typeof data.text !== 'string'
  ) {
    return;
  }

  const targetGroup = registeredGroups[data.chatJid];
  if (!isMain && !(targetGroup && targetGroup.folder === sourceFolder)) {
    logger.warn(
      { chatJid: data.chatJid, sourceFolder },
      'Unauthorized IPC message attempt blocked',
    );
    return;
  }

  if (data.sender && data.chatJid.startsWith('tg:')) {
    const sent = await sendPoolMessage(
      data.chatJid,
      data.text,
      data.sender,
      sourceFolder,
    );
    if (!sent) {
      await deps.sendMessage(data.chatJid, data.text);
    }
  } else {
    await deps.sendMessage(data.chatJid, data.text);
  }

  logger.info(
    { chatJid: data.chatJid, sourceFolder, sender: data.sender },
    'IPC message sent',
  );
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceFolder of groupFolders) {
      const isMain = folderIsMain.get(sourceFolder) === true;
      const messagesDir = path.join(ipcBaseDir, sourceFolder, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceFolder, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processMessageIpc(
                data,
                sourceFolder,
                isMain,
                registeredGroups,
                deps,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceFolder, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceFolder}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceFolder },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceFolder, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceFolder, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceFolder}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceFolder }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceFolder: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        typeof data.prompt === 'string' &&
        typeof data.schedule_type === 'string' &&
        typeof data.schedule_value === 'string' &&
        typeof data.targetJid === 'string'
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceFolder) {
          logger.warn(
            { sourceFolder, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        const schedule = parseSchedule(scheduleType, data.schedule_value);
        if (!schedule) break;
        const { nextRun } = schedule;

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceFolder, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      withTaskAuth(data.taskId, sourceFolder, isMain, 'pause', () => {
        updateTask(data.taskId!, { status: 'paused' });
        logger.info(
          { taskId: data.taskId, sourceFolder },
          'Task paused via IPC',
        );
        deps.onTasksChanged();
      });
      break;

    case 'resume_task':
      withTaskAuth(data.taskId, sourceFolder, isMain, 'resume', () => {
        updateTask(data.taskId!, { status: 'active' });
        logger.info(
          { taskId: data.taskId, sourceFolder },
          'Task resumed via IPC',
        );
        deps.onTasksChanged();
      });
      break;

    case 'cancel_task':
      withTaskAuth(data.taskId, sourceFolder, isMain, 'cancel', () => {
        deleteTask(data.taskId!);
        logger.info(
          { taskId: data.taskId, sourceFolder },
          'Task cancelled via IPC',
        );
        deps.onTasksChanged();
      });
      break;

    case 'update_task':
      withTaskAuth(data.taskId, sourceFolder, isMain, 'update', (task) => {
        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = { ...task, ...updates };
          const schedule = parseSchedule(
            updatedTask.schedule_type,
            updatedTask.schedule_value,
          );
          if (!schedule) return; // Invalid schedule — abort update
          if (schedule.nextRun) updates.next_run = schedule.nextRun;
        }

        updateTask(data.taskId!, updates);
        logger.info(
          { taskId: data.taskId, sourceFolder, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      });
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceFolder },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceFolder,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceFolder },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceFolder },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceFolder, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
