export type WalkReady = { selector: string; text?: string; present?: boolean };
export type WalkEntry = {
  state: string;
  url: string;
  ready: WalkReady;
  actionsSource?: string;
  after?: WalkReady;
};
export declare const STATE_WALK: WalkEntry[];
export declare const ACTIONS: Record<string, string>;
