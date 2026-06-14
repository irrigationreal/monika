export interface JobHandle {
  id: string;
  createdAt: string;
}

export interface JobQueue<TPayload> {
  enqueue(payload: TPayload): Promise<JobHandle>;
  ack(handle: JobHandle): Promise<void>;
  fail(handle: JobHandle, error: Error): Promise<void>;
}
