/**
 * Public API for the doctor module: environment health checks for
 * durable-copilot-sessions.
 */
export { runDoctor, aggregate } from "./doctor.js";
export type { DoctorCheck, DoctorDeps } from "./doctor.js";
