export interface Clock {
  now(): string;
}

export interface IdGenerator {
  nextId(): string;
}
