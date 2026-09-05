import { describe, expect, it } from "vitest";
import type { Issue } from "../../db/schema";
import { rankIssuesByOpenRate } from "./ranking";

function issue(overrides: Partial<Issue> & { opens: number; recipients: number }): Issue {
  return {
    id: crypto.randomUUID(),
    subjectLine: "Subject",
    bodyMd: "Body",
    status: "sent",
    sentAt: new Date(),
    beehiivPostId: "post_x",
    clicks: 0,
    subjectLineCandidates: null,
    sponsorId: null,
    sponsorRevenueCents: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("rankIssuesByOpenRate", () => {
  it("sorts descending by open rate", () => {
    const low = issue({ opens: 10, recipients: 1_000 }); // 1%
    const high = issue({ opens: 400, recipients: 1_000 }); // 40%
    const mid = issue({ opens: 100, recipients: 1_000 }); // 10%

    const ranked = rankIssuesByOpenRate([low, high, mid]);
    expect(ranked.map((r) => r.issue)).toEqual([high, mid, low]);
    expect(ranked[0]?.openRate).toBe(0.4);
  });

  it("excludes issues with 0 recipients rather than dividing by zero", () => {
    const unmeasurable = issue({ opens: 0, recipients: 0 });
    const measurable = issue({ opens: 50, recipients: 500 });

    const ranked = rankIssuesByOpenRate([unmeasurable, measurable]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.issue).toBe(measurable);
  });

  it("returns an empty array for no issues", () => {
    expect(rankIssuesByOpenRate([])).toEqual([]);
  });
});
