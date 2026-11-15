import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

export default defineFeaturePlugin({
  contract,
  name: "RSS",
  description: "Analyze drafts with RSS tools and native UI.",
  setup() {
    return {
      analyze: ({ text }) => ({
        words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        lines: text ? text.split("\n").length : 0,
        headings: text.split("\n").filter((line) => /^#{1,6} /u.test(line)),
      }),
    };
  },
});
