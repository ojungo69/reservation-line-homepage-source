export type ApiRoute = { status?: number; body?: unknown; delayMs?: number };
export type ApiState = {
  page: "/" | "/customer/reservations";
  description: string;
  stub?: Record<string, unknown>;
  routes: Record<string, ApiRoute>;
};
export declare const buildApiStates: (now?: number, query?: Record<string, string>) => Record<string, ApiState>;
