export async function runCanonicalShutdownCleanup({ waitForRetention, conversations, closeConversation }) {
  const failures = [];
  try {
    await waitForRetention();
  } catch (error) {
    failures.push(error);
  }
  for (const conversation of conversations) {
    try {
      await closeConversation(conversation);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'canonical shutdown cleanup failed');
}

export async function runBoundedShutdown({
  beginTransportShutdown,
  gracefulShutdown,
  forceTransportShutdown,
  exit,
  deadlineMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  beginTransportShutdown();
  let timer;
  const deadline = new Promise((resolve) => {
    // Keep the deadline referenced: a fenced graceful promise does not keep the
    // event loop alive, but shutdown must still reach the explicit exit policy.
    timer = setTimer(() => resolve({ graceful: false }), deadlineMs);
  });
  const graceful = Promise.resolve()
    .then(gracefulShutdown)
    .then(() => ({ graceful: true }), (error) => ({ graceful: false, error }));
  const result = await Promise.race([graceful, deadline]);
  if (timer) clearTimer(timer);
  try {
    forceTransportShutdown();
  } finally {
    exit(result.graceful ? 0 : 1);
  }
  return result;
}
