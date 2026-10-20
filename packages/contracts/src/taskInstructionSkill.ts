import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  IsoDateTime,
  TrimmedNonEmptyString,
  RunId,
  RunAttemptId,
  MessageId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ModuleSchema = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(80), Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  version: TrimmedNonEmptyString.check(
    Schema.isMaxLength(32),
    Schema.isPattern(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  kind: Schema.Literal("instruction-only"),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  inputExpectation: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  outputExpectation: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  grantsAccess: Schema.Literal(false),
  tools: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
  permissions: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
});
const decodeModule = Schema.decodeUnknownOption(ModuleSchema);
export const TaskInstructionSkillModule = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decodeModule(raw, { onExcessProperty: "error" }))),
).pipe(Schema.decodeTo(ModuleSchema));
export type TaskInstructionSkillModule = typeof TaskInstructionSkillModule.Type;
const RefSchema = Schema.Struct({
  id: ModuleSchema.fields.id,
  version: ModuleSchema.fields.version,
  contentSha256: Hash,
  moduleSha256: Hash,
});
const decodeRef = Schema.decodeUnknownOption(RefSchema);
export const TaskInstructionSkillRef = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decodeRef(raw, { onExcessProperty: "error" }))),
).pipe(Schema.decodeTo(RefSchema));
export type TaskInstructionSkillRef = typeof TaskInstructionSkillRef.Type;
const ReviewSchema = Schema.Struct({
  reviewId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  module: TaskInstructionSkillRef,
  actorId: TrimmedNonEmptyString,
  reviewedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  bindingSha256: Hash,
});
const decodeReview = Schema.decodeUnknownOption(ReviewSchema);
export const TaskInstructionSkillReview = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decodeReview(raw, { onExcessProperty: "error" }))),
).pipe(Schema.decodeTo(ReviewSchema));
export type TaskInstructionSkillReview = typeof TaskInstructionSkillReview.Type;
export const TaskInstructionSkillReviewState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("available"),
    module: TaskInstructionSkillModule,
    review: TaskInstructionSkillReview,
  }),
]);
export type TaskInstructionSkillReviewState = typeof TaskInstructionSkillReviewState.Type;
/** Adapter acceptance records input delivery, never completion, correctness or task acceptance. */
export const TaskInstructionSkillDelivery = Schema.Struct({
  reviewId: Schema.optionalKey(TrimmedNonEmptyString),
  status: Schema.Literals(["unknown", "adapter-accepted"]),
  module: TaskInstructionSkillRef,
  runId: RunId,
  attemptId: RunAttemptId,
  messageId: MessageId,
  modelSelection: ModelSelection,
  inputSha256: Hash,
  observedAt: IsoDateTime,
});
export type TaskInstructionSkillDelivery = typeof TaskInstructionSkillDelivery.Type;
