export async function runAfterRequestBody(req, readBody, operation) {
  const body = await readBody(req);
  return operation(body);
}

export function responseWritable(res) {
  return !res.destroyed && !res.writableEnded && res.socket?.destroyed !== true;
}

export function isClientDisconnect(req, res, error) {
  return req?.aborted === true || res?.destroyed === true || [
    'ECONNRESET',
    'ERR_STREAM_PREMATURE_CLOSE',
    'ERR_STREAM_DESTROYED',
  ].includes(error?.code);
}

export function writeJson(res, status, body) {
  if (!responseWritable(res)) return false;
  const data = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
    });
    res.end(data);
    return true;
  } catch (error) {
    if (isClientDisconnect(null, res, error)) return false;
    throw error;
  }
}

export function endResponse(res) {
  if (!responseWritable(res)) return false;
  try {
    res.end();
    return true;
  } catch (error) {
    if (isClientDisconnect(null, res, error)) return false;
    throw error;
  }
}

export function writeSse(res, wire) {
  if (!responseWritable(res)) return false;
  try {
    res.write(wire);
    return true;
  } catch (error) {
    if (isClientDisconnect(null, res, error)) return false;
    throw error;
  }
}
