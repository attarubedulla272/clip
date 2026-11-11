export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
  }
}
