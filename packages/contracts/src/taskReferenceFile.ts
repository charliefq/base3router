import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ChatFileAttachment } from "./chatAttachment.ts";
import {
  IsoDateTime,
  TrimmedNonEmptyString,
  RunId,
  RunAttemptId,
  MessageId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Fields = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  source: ChatFileAttachment,
  attachment: ChatFileAttachment,
  contentSha256: Hash,
  actorId: TrimmedNonEmptyString,
  reviewedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  bindingSha256: Hash,
});
const decode = Schema.decodeUnknownOption(Fields);
export const TaskReferenceFileReview = Schema.Unknown.check(
  Schema.makeFilter((raw) => Option.isSome(decode(raw, { onExcessProperty: "error" }))),
).pipe(Schema.decodeTo(Fields));
export type TaskReferenceFileReview = typeof TaskReferenceFileReview.Type;
export const TaskReferenceFileReviewState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("available"), review: TaskReferenceFileReview }),
]);
export type TaskReferenceFileReviewState = typeof TaskReferenceFileReviewState.Type;
export const TaskReferenceFileDelivery = Schema.Struct({
  status: Schema.Literals(["unknown", "adapter-accepted"]),
  reviewId: TrimmedNonEmptyString,
  source: ChatFileAttachment,
  attachment: ChatFileAttachment,
  contentSha256: Hash,
  runId: RunId,
  attemptId: RunAttemptId,
  messageId: MessageId,
  modelSelection: ModelSelection,
  observedAt: IsoDateTime,
});
export type TaskReferenceFileDelivery = typeof TaskReferenceFileDelivery.Type;
