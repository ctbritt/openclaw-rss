import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

export const contract = defineFeatureContract({
  pluginId: "rss",
  operations: {
    analyze: {
      kind: "query",
      description: "Count words and lines and list Markdown headings in a draft.",
      input: Type.Object({ text: Type.String({ maxLength: 32000 }) }, { additionalProperties: false }),
      output: Type.Object({ words: Type.Integer(), lines: Type.Integer(), headings: Type.Array(Type.String()) }),
      tool: { name: "rss_analyze", label: "Analyze draft" },
    },
  },
  events: {},
});
