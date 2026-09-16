export class OflowError extends Error {
  readonly code: string;

  constructor(message: string, code = "OFLOW_ERROR") {
    super(message);
    this.name = "OflowError";
    this.code = code;
  }
}
