export const sendQueueKick = async (
  queue: Queue<unknown> | undefined,
  payload: Record<string, string>
) => {
  if (!queue) {
    return;
  }
  try {
    await queue.send(payload);
  } catch (error) {
    // D1 jobs are still the source of truth; Cron will recover missed kicks —
    // log (don't capture) so repeated failures leave a trace without paging
    // on a self-healing path.
    console.warn("queue_kick_failed", {
      payload,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
