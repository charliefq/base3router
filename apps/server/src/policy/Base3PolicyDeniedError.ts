import * as Schema from "effect/Schema";

export class Base3PolicyDeniedError extends Schema.TaggedError<Base3PolicyDeniedError>()(
  "Base3PolicyDeniedError",
  {
    reason: Schema.String,
    commandType: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? `Base3 policy denied ${this.commandType} (${this.reason}).`;
  }
}
