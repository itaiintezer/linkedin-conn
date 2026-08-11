/**
 * Types for control-file.mjs, hand-written because the implementation must stay plain ESM (the
 * supervisor runs on a bare Node, before `npm install` has necessarily worked).
 */
export type ControlAction = 'update' | 'restart';
export type ControlStatus = 'requested' | 'running' | 'done' | 'failed';

export interface Control {
  action: ControlAction;
  status: ControlStatus;
  requested_at: string;
  started_at?: string;
  finished_at: string | null;
  from_sha: string | null;
  to_sha: string | null;
  changes: string[];
  error: string | null;
  unchanged: boolean;
}

export interface ControlSummary {
  state: 'idle' | 'busy' | 'done' | 'failed';
  message: string;
}

export const CONTROL_FILE: string;
export function controlPath(dataDir: string): string;
export function readControl(dataDir: string): Control | null;
export function writeControl(dataDir: string, control: Control): Control;
export function clearControl(dataDir: string): void;
export function newRequest(action: ControlAction, nowIso: string): Control;
export function markRunning(control: Control, nowIso: string): Control;
export function markDone(
  control: Control,
  result: { from?: string | null; to?: string | null; changes?: string[]; unchanged?: boolean },
  nowIso: string,
): Control;
export function markFailed(control: Control, error: unknown, nowIso: string): Control;
export function isPending(control: Control | null): boolean;
export function summarizeControl(control: Control | null): ControlSummary;
