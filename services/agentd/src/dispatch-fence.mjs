export const DISPATCH_FENCE_CUSTOM_TYPE = 'monika.dispatch.fence';
export const DISPATCH_FENCE_VERSION = 1;

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
function validGeneration(value) { return Number.isSafeInteger(value) && value >= 0; }

export function readDispatchFence(entries) {
  let generation = 0;
  const accepted = new Map();
  const dispositions = new Map();
  for (const entry of entries) {
    const data = entry?.type === 'custom' && entry.customType === DISPATCH_FENCE_CUSTOM_TYPE ? entry.data : null;
    if (!data || data.version !== DISPATCH_FENCE_VERSION || !validGeneration(data.generation)) continue;
    generation = Math.max(generation, data.generation);
    if (data.kind === 'dispatch-accepted' && validId(data.dispatchId)) {
      accepted.set(data.dispatchId, data.generation);
      if (DISPATCH_DISPOSITIONS.includes(data.disposition)) dispositions.set(data.dispatchId, data.disposition);
    }
  }
  return { generation, accepted, dispositions };
}

export function resolveDispatchGeneration(sessionManager, requestedGeneration) {
  if (requestedGeneration === undefined) return readDispatchFence(sessionManager.getBranch()).generation;
  if (!validGeneration(requestedGeneration)) throw new TypeError('valid generation is required');
  return requestedGeneration;
}

export function inspectDispatch(sessionManager, { dispatchId, generation }) {
  if (!validId(dispatchId) || !validGeneration(generation)) throw new TypeError('valid dispatch_id and generation are required');
  const state = readDispatchFence(sessionManager.getBranch());
  if (state.accepted.has(dispatchId)) {
    const duplicate = { status: 'duplicate', generation: state.accepted.get(dispatchId) };
    const disposition = state.dispositions.get(dispatchId);
    return disposition ? { ...duplicate, disposition } : duplicate;
  }
  if (generation < state.generation) return { status: 'stale', generation: state.generation };
  return { status: 'ready', generation };
}

export async function prepareDispatch(sessionManager, input, prepare) {
  const inspected = inspectDispatch(sessionManager, input);
  if (inspected.status !== 'ready') return { inspection: inspected, prepared: null };
  const prepared = await prepare();
  return { inspection: inspectDispatch(sessionManager, input), prepared };
}

export function acceptDispatch(sessionManager, { dispatchId, generation, disposition }) {
  const inspected = inspectDispatch(sessionManager, { dispatchId, generation });
  if (inspected.status !== 'ready') return inspected;
  if (disposition !== undefined && !DISPATCH_DISPOSITIONS.includes(disposition)) {
    throw new TypeError(`invalid Pi dispatch disposition: ${String(disposition)}`);
  }
  sessionManager.appendCustomEntry(DISPATCH_FENCE_CUSTOM_TYPE, {
    version: DISPATCH_FENCE_VERSION, kind: 'dispatch-accepted', dispatchId, generation,
    ...(disposition ? { disposition } : {}), createdAt: new Date().toISOString(),
  });
  return { status: 'accepted', generation };
}

export const DISPATCH_DISPOSITIONS = Object.freeze(['started', 'queued', 'handled']);

export function dispatchPreflightHandler(sessionManager, input, onResult) {
  return (disposition) => {
    if (!DISPATCH_DISPOSITIONS.includes(disposition)) {
      throw new TypeError(`invalid Pi dispatch disposition: ${String(disposition)}`);
    }
    const outcome = acceptDispatch(sessionManager, { ...input, disposition });
    if (outcome.status !== 'accepted') {
      throw new Error(`dispatch preflight acceptance failed: ${outcome.status}`);
    }
    onResult?.(disposition);
  };
}

export async function awaitDispatchPreflight(accepted, promptPromise) {
  // Pi 1.x intentionally omits the callback for rejected prompt setup. Keep a
  // rejection observer attached from the start so callers never hang waiting
  // for a disposition that cannot arrive.
  const promptRejected = promptPromise.then(() => new Promise(() => {}));
  return Promise.race([accepted, promptRejected]);
}

export function createDispatchPreflightGate(sessionManager, input, onResult) {
  let settled = false;
  let resolveAccepted;
  let rejectAccepted;
  const accepted = new Promise((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  const handle = dispatchPreflightHandler(sessionManager, input, (disposition) => {
    if (settled) return;
    settled = true;
    onResult?.(disposition);
    resolveAccepted(disposition);
  });
  return {
    accepted,
    preflightResult(disposition) {
      if (settled) return;
      try {
        handle(disposition);
      } catch (error) {
        settled = true;
        rejectAccepted(error);
        throw error;
      }
    },
  };
}

export function advanceDispatchFence(sessionManager, generation) {
  if (!validGeneration(generation)) throw new TypeError('valid generation is required');
  const state = readDispatchFence(sessionManager.getBranch());
  if (generation <= state.generation) return { advanced: false, generation: state.generation };
  sessionManager.appendCustomEntry(DISPATCH_FENCE_CUSTOM_TYPE, {
    version: DISPATCH_FENCE_VERSION, kind: 'interrupt-fence', generation, createdAt: new Date().toISOString(),
  });
  return { advanced: true, generation };
}
