// The native TUI creates a separate thread for generated titles. Its turns use
// the same protocol as human turns, but their threadSource identifies the helper.
export function createCodexOrigins() {
  const titleThreads = new Set();
  return {
    observe(message) {
      const thread = message?.result?.thread
        ?? (message?.method === 'thread/started' ? message.params?.thread : undefined);
      if (!thread?.id || !Object.hasOwn(thread, 'threadSource')) return;
      if (thread.threadSource === 'thread_title') titleThreads.add(thread.id);
      else titleThreads.delete(thread.id);
    },
    isHelper(message) {
      return titleThreads.has(message?.params?.threadId);
    },
  };
}
