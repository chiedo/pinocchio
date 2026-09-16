export const LOCAL_JOBS_COMPATIBILITY = {
  status: "blocked" as const,
  code: "LOCAL_BACKGROUND_TASK_API_UNAVAILABLE",
  runtime: "public @github/copilot-sdk 1.0.13",
  detail:
    "The pinned public SDK exposes task cancellation and background-task events, but no public native agent-task start method. Local active-session execution remains disabled until a supported API proves separate execution, memory/tool identity, cancellation, and teardown.",
};

export function localJobsUnavailable() {
  return {
    status: "unavailable" as const,
    backend: "local" as const,
    compatibility: LOCAL_JOBS_COMPATIBILITY,
  };
}
