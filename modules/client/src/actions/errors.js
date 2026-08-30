export class HarnessDispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
