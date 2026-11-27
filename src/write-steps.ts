import { OperationError, safeError } from "./http.js";

export function errorDetails(error: unknown, operation: string) {
  const details = safeError(error);
  return { ...details, operation: details.operation ?? operation };
}

export function skipStep(reason: string, recovery?: string) {
  return { state: "not_attempted" as const, reason, recovery };
}

type Recovery = Record<"rejected" | "uncertain" | "not_attempted", string>;
type WriteStep<T> = { state: "done"; value: T } | ({ state: keyof Recovery; recovery: string } & ReturnType<typeof errorDetails>);

export async function writeStep<T>(operation: string, recovery: Recovery, write: () => Promise<T>): Promise<WriteStep<T>> {
  try {
    return { state: "done", value: await write() };
  } catch (error) {
    const state = error instanceof OperationError ? error.writeFailure ?? "not_attempted" : "uncertain";
    return { state, ...errorDetails(error, operation), recovery: recovery[state] };
  }
}

export function stepReport<T>(step: WriteStep<T>) {
  return step.state === "done" ? { state: step.state } : step;
}
