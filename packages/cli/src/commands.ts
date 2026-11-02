/** The README command sketch. Every command is a planned stub until its issue lands. */
export interface PlannedCommand {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Mutating commands must support --dry-run once implemented. */
  readonly mutating: boolean;
}

export const PLANNED_COMMANDS: readonly PlannedCommand[] = [
  {
    name: "init",
    usage: "cantiere init",
    summary: "set up the yard for this repo or workspace",
    mutating: true,
  },
  {
    name: "dispatch",
    usage: 'cantiere dispatch "<task>"',
    summary: "queue a task; an agent picks it up in its own worktree",
    mutating: true,
  },
  {
    name: "crew",
    usage: "cantiere crew",
    summary: "live view: who is working on what, who is stuck",
    mutating: false,
  },
  {
    name: "steer",
    usage: 'cantiere steer <task> "<message>"',
    summary: "send a steering message to a running task",
    mutating: true,
  },
  {
    name: "land",
    usage: "cantiere land <task>",
    summary: "bring finished work back through its gate",
    mutating: true,
  },
  {
    name: "cleanup",
    usage: "cantiere cleanup <task>",
    summary: "remove a finished worktree, never unlanded work",
    mutating: true,
  },
];
