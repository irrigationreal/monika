export async function shutdownStatefulMemory({ summarize, getClient, clearClient }) {
  let saveError;
  let closeError;
  try {
    await summarize();
  } catch (error) {
    saveError = error;
  }

  try {
    getClient()?.close();
  } catch (error) {
    closeError = error;
  } finally {
    clearClient();
  }

  // Durable save failure is the primary lifecycle result. Cleanup failure is
  // surfaced when saving succeeded, but must not hide a lost archive.
  if (saveError) throw saveError;
  if (closeError) throw closeError;
}
