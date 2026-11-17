// Metrics describe ONE model request, not a user turn or tool execution.
export function summarizeGeneration(raw = null) {
  const number = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const ttft = number(raw?.ttft);
  const streaming = number(raw?.streaming);
  const duration = ttft !== null && streaming !== null ? ttft + streaming : null;
  const output = number(raw?.output);
  const reply = number(raw?.reply);
  const thinking = number(raw?.thinking);
  const splitMatches = output !== null && reply !== null && thinking !== null && output === reply + thinking;
  return {
    requestIndex: raw?.requestIndex ?? null,
    ttft, streaming, duration, output,
    reply: splitMatches ? reply : null,
    thinking: splitMatches ? thinking : null,
    tps: output !== null && output > 0 && duration !== null && duration > 0 ? output / duration : null,
  };
}

// Footer speed is the latest COMPLETED request after the latest user input.
// Verified local enums: USER_INPUT=14, PLANNER_RESPONSE=15, DONE=3.
export function summarizeTurnSpeed(requests, steps, userStepIndex) {
  if (!Number.isInteger(userStepIndex)) return null;
  const stepMap = new Map(steps.map(step => [step.idx, step]));
  let generation = null;
  let completedAtMs = 0;
  for (const request of requests) {
    if (request.lastStepIndex < userStepIndex || request.requestError?.kind !== 'none') continue;
    const response = request.stepIndices?.map(idx => stepMap.get(idx)).find(step => step?.step_type === 15 && step.idx > userStepIndex && step.status === 3);
    if (!response) continue;
    const candidate = summarizeGeneration(request.generation);
    if (candidate.tps === null) continue;
    generation = candidate;
    completedAtMs = response.completedAtMs || 0;
  }
  return {
    userStepIndex, generation, completedAtMs,
    hasActiveStep: steps.some(step => step.idx > userStepIndex && step.step_type !== 14 && [1, 2, 8, 9, 11].includes(step.status)),
  };
}
