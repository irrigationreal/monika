export async function shutdownStatefulMemory({ summarize, getClient, clearClient }) {
  try {
    await summarize();
  } finally {
    try {
      getClient()?.close();
    } finally {
      clearClient();
    }
  }
}
