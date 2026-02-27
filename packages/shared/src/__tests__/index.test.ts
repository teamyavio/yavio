import { describe, expect, it } from "vitest";
import { YavioError, isYavioError } from "../index.js";
import { BaseEvent, EventType, IngestBatch } from "../index.js";
import { Uuid, WorkspaceRole, WorkspaceSlug } from "../index.js";

describe("barrel exports", () => {
  it("re-exports errors module", () => {
    expect(YavioError).toBeDefined();
    expect(isYavioError).toBeDefined();
  });

  it("re-exports events module", () => {
    expect(BaseEvent).toBeDefined();
    expect(EventType).toBeDefined();
    expect(IngestBatch).toBeDefined();
  });

  it("re-exports validation module", () => {
    expect(Uuid).toBeDefined();
    expect(WorkspaceRole).toBeDefined();
    expect(WorkspaceSlug).toBeDefined();
  });
});
