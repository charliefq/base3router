import type {
  TaskFirstLaunch,
  TaskReferenceFileReview,
  TaskInstructionSkillReview,
} from "@t3tools/contracts";
import { digestCanonical } from "./actionCanonical.ts";
/** Both proof fields are excluded to avoid recursive, order-dependent review bindings. */
export function taskFirstLaunchInput(launch: TaskFirstLaunch) {
  const { instructionSkill: _skill, referenceFile: _file, ...input } = launch;
  return input;
}
export function jointTaskInputBinding(launch: TaskFirstLaunch) {
  if (!launch.referenceFile || !launch.instructionSkill)
    throw new Error("Both reviewed inputs are required.");
  const { bindingSha256: _fileHash, ...file } = launch.referenceFile;
  const { bindingSha256: _skillHash, ...skill } = launch.instructionSkill;
  return digestCanonical({
    kind: "reference-skill-first-launch-v1",
    launch: taskFirstLaunchInput(launch),
    referenceFile: file,
    instructionSkill: skill,
  });
}
export function verifyJointTaskInputReview(launch: TaskFirstLaunch) {
  const file = launch.referenceFile,
    skill = launch.instructionSkill;
  if (
    !file ||
    !skill ||
    file.reviewId !== skill.reviewId ||
    file.actorId !== skill.actorId ||
    file.reviewedAt !== skill.reviewedAt ||
    file.expiresAt !== skill.expiresAt
  )
    throw new Error("Input reviews are not one joint issuance.");
  const binding = jointTaskInputBinding(launch);
  if (file.bindingSha256 !== binding || skill.bindingSha256 !== binding)
    throw new Error("Joint reviewed inputs changed.");
}

export function jointTaskInputSelectionsMatch(
  file: TaskReferenceFileReview | undefined,
  skill: TaskInstructionSkillReview | undefined,
) {
  return (
    !!file &&
    !!skill &&
    file.reviewId === skill.reviewId &&
    file.actorId === skill.actorId &&
    file.reviewedAt === skill.reviewedAt &&
    file.expiresAt === skill.expiresAt &&
    file.bindingSha256 === skill.bindingSha256
  );
}
