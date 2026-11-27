/**
 * The store of the task templates of the workspace, owned by the worker core. One JSON file per
 * template lives in the workspace `templates/` folder, plain like the task records, so a restart
 * loses nothing. A template holds the brief a task starts from. The board fills its create form
 * from one, the task tool copies one on a create, and the board saves a record as one.
 */

import {
  readTaskTemplate,
  type TaskRecord,
  type TaskTemplate,
  type TaskTemplateFields,
} from '../shared/tasks.js';
import { joinPath, listDirectoryNames, makeDirectory, readTextFile, removePath, writeTextFile } from './node-file-system.js';

/** Owns the task templates of the workspace. */
export class TaskTemplateStore {
  private readonly root: string;
  private readonly templates = new Map<string, TaskTemplate>();
  private readonly listeners = new Set<() => void>();

  /**
   * @param workspacePath The absolute path of the workspace directory, the parent of `templates/`.
   */
  constructor(workspacePath: string) {
    this.root = joinPath(workspacePath, 'templates');
  }

  /** Reads every stored template into memory. Call once at boot, before any tool runs. */
  async load(): Promise<void> {
    await makeDirectory(this.root);
    const names = await listDirectoryNames(this.root);
    if (!names) {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('task-template-') || !name.endsWith('.json')) {
        continue;
      }
      const text = await readTextFile(joinPath(this.root, name));
      // eslint-disable-next-line local/prefer-truthiness -- an empty template file reads as an empty string, only a failed read skips
      if (text === null) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      const template = readTaskTemplate(value);
      if (template && template.id === name.slice('task-template-'.length, -'.json'.length)) {
        this.templates.set(template.id, template);
      }
    }
  }

  /** Subscribes to every template change. The listener holds no arguments: it re-reads the list. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads every template, newest first. */
  list(): readonly TaskTemplate[] {
    return [...this.templates.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Reads one template by its id, or by the start of its id. Null when none matches, or when the
   * start matches several. */
  resolve(id: string): TaskTemplate | null {
    const exact = this.templates.get(id);
    if (exact) {
      return exact;
    }
    const matches = [...this.templates.values()].filter((template) => template.id.startsWith(id));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  /**
   * Creates one template from the brief fields.
   *
   * @param fields The brief the template holds. The goals and the plan start fresh.
   * @returns The template.
   */
  async create(fields: TaskTemplateFields): Promise<TaskTemplate> {
    const template: TaskTemplate = {
      id: crypto.randomUUID(),
      title: fields.title,
      description: fields.description,
      goal: fields.goal,
      goals: [...fields.goals],
      plan: [...fields.plan],
      category: fields.category,
      createdAt: new Date().toISOString(),
    };
    this.templates.set(template.id, template);
    await this.write(template);
    this.emit();
    return template;
  }

  /**
   * Saves one record as a template: the template keeps its brief, its checklist texts, its plan
   * texts, and its category. The record stays as it is.
   *
   * @param record The record to copy.
   * @returns The template.
   */
  async save(record: TaskRecord): Promise<TaskTemplate> {
    return this.create({
      title: record.title,
      description: record.description,
      goal: record.goal,
      goals: record.goals.map((goal) => goal.text),
      plan: record.plan.map((step) => step.text),
      category: record.category,
    });
  }

  /**
   * Removes one template from memory and from the workspace folder. The tasks that came from it
   * stay as they are.
   *
   * @param id The template id.
   */
  async remove(id: string): Promise<void> {
    if (!this.templates.has(id)) {
      return;
    }
    this.templates.delete(id);
    await removePath(joinPath(this.root, `task-template-${id}.json`));
    this.emit();
  }

  /** Fires every listener. */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Writes one template to its file. */
  private async write(template: TaskTemplate): Promise<void> {
    await writeTextFile(
      joinPath(this.root, `task-template-${template.id}.json`),
      JSON.stringify({ kind: 'task-template', ...template }, null, 2),
    );
  }
}
