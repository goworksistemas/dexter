export class AuthError extends Error {
  statusCode = 401

  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

export class ForbiddenError extends Error {
  statusCode = 403

  constructor(message: string) {
    super(message)
    this.name = "ForbiddenError"
  }
}

export class NotFoundError extends Error {
  statusCode = 404

  constructor(message: string) {
    super(message)
    this.name = "NotFoundError"
  }
}
